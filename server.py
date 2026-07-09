import os
import json
import asyncio
from datetime import datetime
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from groq import AsyncGroq

load_dotenv()

app = FastAPI(title="Walrus Ecosystem Context Agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── MemWal setup ──────────────────────────────────────────────────────────────
try:
    from memwal import MemWal, RecallParams

    memwal = MemWal.create(
        key=os.environ["MEMWAL_PRIVATE_KEY"],
        account_id=os.environ["MEMWAL_ACCOUNT_ID"],
        server_url=os.environ.get("MEMWAL_SERVER_URL", "https://relayer.memory.walrus.xyz"),
        namespace="walrus-copilot",
    )
    MEMWAL_AVAILABLE = True
    print("✅ Walrus Memory connected")
except Exception as e:
    print(f"⚠️  Walrus Memory unavailable: {e}")
    MEMWAL_AVAILABLE = False
    memwal = None

# ── Groq setup ────────────────────────────────────────────────────────────────
groq_client = AsyncGroq(api_key=os.environ.get("GROQ_API_KEY", ""))

GROQ_MODEL = "llama-3.3-70b-versatile"

# ── System prompt ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are a Walrus ecosystem co-pilot with persistent memory via Walrus Memory (MemWal).

You maintain three types of structured memory entries:
- [ECOSYSTEM] entity_name | type(protocol/app/tool/person/bounty) | status(active/deprecated/coming_soon/UNKNOWN) | key_links | YYYY-MM-DD
- [DECISION] YYYY-MM-DD | choice | rejected_alternatives | rationale | open_risk
- [OPPORTUNITY] idea_summary | matches | contacts | deadlines

YOUR RULES:
1. ALWAYS check recalled memories first — never treat the user as a new user if memory exists
2. Write [ECOSYSTEM] entries whenever you discover/verify any Walrus entity (SDK version, protocol feature, app, tool, person, bounty)
3. Write [DECISION] entries when the user makes a build choice or commitment
4. Write [OPPORTUNITY] entries when you spot a match between user ideas and ecosystem activity (bounties, grants, similar projects, relevant people)
5. Flag any [ECOSYSTEM] entry older than 14 days as ⚠️ STALE
6. When the user returns after a gap, LEAD with: "Since last session, X changed. You're working on Y. Here's what's new."
7. NEVER give generic getting-started answers if memory shows prior context
8. If you can't verify status of something, write UNKNOWN — never guess
9. After writing any memory entry, call recall_memory to confirm it's accessible

Today's date: """ + datetime.utcnow().strftime("%Y-%m-%d") + """

IMPORTANT: Be conversational and direct. Don't just list memory operations — answer the user's actual question while using memory tools in the background."""

# ── Tool definitions ──────────────────────────────────────────────────────────
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "remember_ecosystem",
            "description": "Write an [ECOSYSTEM] memory entry for a Walrus entity (SDK, protocol, app, tool, person, bounty). Use this to track the living state of the ecosystem.",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_name": {"type": "string", "description": "Name of the entity (e.g. 'typescript-sdk', 'walrus-blob-pricing', 'media-dapp-bounty')"},
                    "entity_type": {"type": "string", "enum": ["protocol", "app", "tool", "person", "bounty", "other"], "description": "Type of entity"},
                    "status": {"type": "string", "enum": ["active", "deprecated", "coming_soon", "UNKNOWN"], "description": "Current status — only write UNKNOWN if you cannot verify"},
                    "key_links": {"type": "string", "description": "Relevant URLs, GitHub repos, docs (comma separated)"},
                    "notes": {"type": "string", "description": "Any additional context, version numbers, warnings, etc."},
                },
                "required": ["entity_name", "entity_type", "status"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remember_decision",
            "description": "Write a [DECISION] memory entry when the user makes a build choice or commitment.",
            "parameters": {
                "type": "object",
                "properties": {
                    "choice": {"type": "string", "description": "What the user decided to do"},
                    "rejected_alternatives": {"type": "string", "description": "What was considered but rejected"},
                    "rationale": {"type": "string", "description": "Why this choice was made"},
                    "open_risk": {"type": "string", "description": "Known risks or uncertainties with this decision"},
                },
                "required": ["choice", "rationale"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remember_opportunity",
            "description": "Write an [OPPORTUNITY] memory entry when you spot a match between the user's idea and ecosystem activity (bounties, grants, similar projects, relevant people).",
            "parameters": {
                "type": "object",
                "properties": {
                    "idea_summary": {"type": "string", "description": "What the user wants to build"},
                    "matches": {"type": "string", "description": "Bounties, grants, or existing projects that match"},
                    "contacts": {"type": "string", "description": "Relevant people or teams to reach out to"},
                    "deadlines": {"type": "string", "description": "Any relevant deadlines"},
                },
                "required": ["idea_summary", "matches"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "recall_memory",
            "description": "Search Walrus Memory for relevant past context. Use this to look up specific topics, check prior decisions, or verify what the user has built before.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural language query to search memories"},
                    "limit": {"type": "integer", "description": "Max number of results (default 5)", "default": 5},
                },
                "required": ["query"],
            },
        },
    },
]


# ── Tool execution ────────────────────────────────────────────────────────────
async def execute_tool(name: str, args: dict) -> tuple[str, dict]:
    """Execute a tool call and return (result_text, event_data)."""
    today = datetime.utcnow().strftime("%Y-%m-%d")

    if name == "remember_ecosystem":
        text = (
            f"[ECOSYSTEM] {args['entity_name']} | {args['entity_type']} | {args['status']} | "
            f"{args.get('key_links', 'N/A')} | {today}"
        )
        if args.get("notes"):
            text += f" | {args['notes']}"
        result = await _memwal_remember(text)
        event = {"type": "memory_write", "tag": "ECOSYSTEM", "entity": args["entity_name"], "status": args["status"], "text": text}
        return result, event

    elif name == "remember_decision":
        text = (
            f"[DECISION] {today} | {args['choice']} | "
            f"rejected: {args.get('rejected_alternatives', 'none')} | "
            f"rationale: {args['rationale']} | "
            f"open_risk: {args.get('open_risk', 'none')}"
        )
        result = await _memwal_remember(text)
        event = {"type": "memory_write", "tag": "DECISION", "entity": args["choice"][:40], "status": "logged", "text": text}
        return result, event

    elif name == "remember_opportunity":
        text = (
            f"[OPPORTUNITY] {args['idea_summary']} | "
            f"matches: {args['matches']} | "
            f"contacts: {args.get('contacts', 'none')} | "
            f"deadlines: {args.get('deadlines', 'none')}"
        )
        result = await _memwal_remember(text)
        event = {"type": "memory_write", "tag": "OPPORTUNITY", "entity": args["idea_summary"][:40], "status": "logged", "text": text}
        return result, event

    elif name == "recall_memory":
        memories = await _memwal_recall(args["query"], args.get("limit", 5))
        event = {"type": "recall", "query": args["query"], "count": len(memories), "results": memories}
        if memories:
            return "Found memories:\n" + "\n".join(f"- {m}" for m in memories), event
        return "No relevant memories found.", event

    return "Unknown tool.", {}


async def _memwal_remember(text: str) -> str:
    if not MEMWAL_AVAILABLE or memwal is None:
        return f"[DEMO] Would store: {text}"
    try:
        await asyncio.get_event_loop().run_in_executor(
            None, lambda: memwal.remember_and_wait(text)
        )
        return f"✅ Stored to Walrus Memory"
    except Exception as e:
        return f"⚠️ Memory write failed: {e}"


async def _memwal_recall(query: str, limit: int = 10) -> list[str]:
    if not MEMWAL_AVAILABLE or memwal is None:
        return []
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, lambda: memwal.recall({"query": query, "limit": limit})
        )
        return [r.text for r in result.results] if result.results else []
    except Exception as e:
        print(f"Recall error: {e}")
        return []


# ── Request / Response models ─────────────────────────────────────────────────
class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []


# ── Main chat stream ──────────────────────────────────────────────────────────
async def chat_stream(req: ChatRequest) -> AsyncGenerator[str, None]:
    def sse(data: dict) -> str:
        return f"data: {json.dumps(data)}\n\n"

    # Step 1: Pre-flight recall (Agent B)
    prior_memories = await _memwal_recall(req.message, limit=12)
    yield sse({"type": "recall", "query": req.message, "count": len(prior_memories), "results": prior_memories})

    # Build memory context string
    memory_context = ""
    if prior_memories:
        memory_context = "\n\n--- RECALLED MEMORIES (from Walrus Memory) ---\n"
        for m in prior_memories:
            memory_context += f"{m}\n"
        memory_context += "--- END MEMORIES ---\n"

    # Build message history for Groq
    messages = [{"role": "system", "content": SYSTEM_PROMPT + memory_context}]
    for msg in req.history[-20:]:  # keep last 20 turns
        messages.append({"role": msg.role, "content": msg.content})
    messages.append({"role": "user", "content": req.message})

    # Step 2: Agentic tool-call loop (max 6 turns)
    for turn in range(6):
        response = await groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
            temperature=0.7,
            max_tokens=2048,
            stream=False,
        )

        assistant_msg = response.choices[0].message
        tool_calls = assistant_msg.tool_calls or []

        if not tool_calls:
            # No more tool calls — stream the final text response
            final_text = assistant_msg.content or ""
            # Stream word by word for nice effect
            words = final_text.split(" ")
            for i, word in enumerate(words):
                chunk = word + (" " if i < len(words) - 1 else "")
                yield sse({"type": "token", "content": chunk})
                await asyncio.sleep(0.01)
            break

        # Execute all tool calls in this turn
        messages.append({"role": "assistant", "content": assistant_msg.content, "tool_calls": [
            {"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
            for tc in tool_calls
        ]})

        for tc in tool_calls:
            try:
                args = json.loads(tc.function.arguments)
            except Exception:
                args = {}

            result_text, event = await execute_tool(tc.function.name, args)

            # Emit memory event to frontend
            if event:
                yield sse(event)

            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result_text,
            })

    yield sse({"type": "done"})


@app.post("/chat")
async def chat(req: ChatRequest):
    return StreamingResponse(
        chat_stream(req),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "memwal": MEMWAL_AVAILABLE,
        "groq_model": GROQ_MODEL,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
