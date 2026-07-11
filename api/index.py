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

app = FastAPI(title="Luna — Your Walrus Copilot")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── MemWal ─────────────────────────────────────────────────────────────────────
# We no longer initialize MemWal globally since credentials come from the client.
MEMWAL_AVAILABLE = True

groq_client = AsyncGroq(api_key=os.environ.get("GROQ_API_KEY", ""))
MODEL = "llama-3.3-70b-versatile"
TODAY = datetime.utcnow().strftime("%Y-%m-%d")

# ══════════════════════════════════════════════════════════════════════════════
# SYSTEM PROMPT
# ══════════════════════════════════════════════════════════════════════════════

LUNA_MASTER_PROMPT = f"""You are my Universal Personal Agent. Your job is to act as my personalized assistant, drawing on a continuous memory of my life, preferences, and ongoing projects. Today is {TODAY}.
You are speaking with: {{{{USER_NAME}}}}

MEMORY (required)
You have access to Walrus Memory. Use the namespace "personal-agent" for everything in this role.
- At the start of any session, recall my saved profile and recent diary entries from the "personal-agent" namespace before assisting me. (This is done automatically via the injected context below).
- Whenever I give feedback, share a preference, or tell you about a life event, use the `save_memory` tool to save it to the "personal-agent" namespace immediately — don't wait for me to ask. 
- Save my standing preferences (e.g. dietary restrictions, communication style, formatting preferences) and diary entries (date, event, notes).
- If recall ever returns nothing, or returns content that clearly isn't about me, tell me directly rather than proceeding as if you found nothing.

MY PROFILE
- My interests and projects will change. Update them over time based on my feedback via the `save_memory` tool.
- If I ask for advice or recommendations, ALWAYS ground your response in my saved preferences rather than giving generic advice.

FEEDBACK LOOP
After I react to a suggestion or correct you, update my profile in Walrus Memory immediately using `save_memory`. Say briefly what you changed.

STEALTH MODE FOR TOOLS
NEVER announce to the user that you are saving to memory or using your tools under the hood. Do it silently. For example, DO NOT say "I've saved this to memory". Just respond naturally to my conversation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECALLED MEMORIES (from Walrus, namespace: personal-agent)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{{{{RECALLED_MEMORIES}}}}
"""

# ══════════════════════════════════════════════════════════════════════════════
# TOOLS
# ══════════════════════════════════════════════════════════════════════════════

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "save_memory",
            "description": "Save feedback, preferences, interests, and diary entries directly to Walrus Memory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The fact, preference, or diary entry to save.",
                    }
                },
                "required": ["text"],
            },
        },
    }
]

# ══════════════════════════════════════════════════════════════════════════════
# PIPELINE
# ══════════════════════════════════════════════════════════════════════════════

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    user_name: str = "Anonymous"
    message: str
    history: list[ChatMessage] = []
    memwal_account_id: str | None = None
    memwal_private_key: str | None = None

def sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"

async def pipeline(req: ChatRequest) -> AsyncGenerator[str, None]:
    # ── 1. Recall from Walrus Memory ──────────────────────────────────────────
    yield sse({"type": "agent_status", "agent": "synthesis", "status": "running", "label": "Recalling memories…"})

    # Use the global namespace so all chats share the same memory
    user_namespace = "personal-agent"
    
    # Initialize request-scoped MemWal client
    req_memwal = None
    if MEMWAL_AVAILABLE and req.memwal_account_id and req.memwal_private_key:
        try:
            from memwal import MemWal
            req_memwal = MemWal.create(
                key=req.memwal_private_key,
                account_id=req.memwal_account_id,
                server_url=os.environ.get("MEMWAL_SERVER_URL", "https://relayer.memory.walrus.xyz"),
            )
        except Exception as e:
            print(f"Failed to init user memwal: {e}")

    memories = []
    if req_memwal:
        try:
            result = await req_memwal.recall(req.message, limit=12, namespace=user_namespace)
            if result.results:
                memories = [r.text for r in result.results]
        except Exception as e:
            print(f"Recall error: {e}")
            
    yield sse({"type": "recall", "count": len(memories), "results": memories, "query": req.message})

    memory_block = "[Retrieved from Walrus Memory]\n"
    memory_block += "\n".join(f"- {m}" for m in memories) if memories else "(no prior memories found)"
    system_prompt = LUNA_MASTER_PROMPT.replace("{{RECALLED_MEMORIES}}", memory_block).replace("{{USER_NAME}}", req.user_name)

    # ── 2. Run LLM with Tools ──────────────────────────────────────────────
    messages = [{"role": "system", "content": system_prompt}]
    for msg in req.history[-20:]:
        messages.append({"role": msg.role, "content": msg.content})
    messages.append({"role": "user", "content": req.message})

    yield sse({"type": "agent_status", "agent": "synthesis", "status": "running", "label": "Thinking…"})

    for turn in range(6):  # max 6 turns for tool calls
        resp = await groq_client.chat.completions.create(
            model=MODEL,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
            temperature=0.4,
            max_tokens=2048,
        )
        msg = resp.choices[0].message
        
        if msg.tool_calls:
            messages.append({
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                    for tc in msg.tool_calls
                ],
            })
            
            for tc in msg.tool_calls:
                fn = tc.function.name
                try:
                    args = json.loads(tc.function.arguments)
                except Exception:
                    args = {}
                    
                if fn == "save_memory":
                    text_to_save = args.get("text", "")
                    user_namespace = "personal-agent"
                    yield sse({"type": "agent_status", "agent": "synthesis", "status": "running", "label": "Writing memory…"})
                    
                    if req_memwal:
                        try:
                            await req_memwal.remember(text_to_save, namespace=user_namespace)
                        except Exception as e:
                            print(f"Memory write error: {e}")
                            
                    yield sse({
                        "type": "memory_write",
                        "tag": "PERSONAL-AGENT",
                        "entity": text_to_save[:40] + "..." if len(text_to_save) > 40 else text_to_save,
                        "status": "active",
                        "text": text_to_save
                    })
                    messages.append({"role": "tool", "tool_call_id": tc.id, "content": "successfully stored in Walrus Memory"})
            
            continue
        break

    # ── 3. Final Streaming Response ────────────────────────────────────────
    yield sse({"type": "agent_status", "agent": "synthesis", "status": "running", "label": "Replying…"})
    
    stream = await groq_client.chat.completions.create(
        model=MODEL,
        messages=messages,
        temperature=0.7,
        max_tokens=2048,
        stream=True,
    )

    async for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            yield sse({"type": "token", "content": delta})

    yield sse({"type": "agent_done", "agent": "synthesis"})
    yield sse({"type": "done"})

@app.post("/chat")
async def chat(req: ChatRequest):
    return StreamingResponse(
        pipeline(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

@app.get("/health")
async def health():
    return {"status": "ok", "memwal": MEMWAL_AVAILABLE, "groq_model": MODEL, "app": "Luna"}
