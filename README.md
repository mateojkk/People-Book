# Luna: Universal Portable AI Memory

**Luna** is a showcase application for a **Universal Personal Agent**, built for the Walrus Hackathon. 

Today, the average consumer's AI experience is heavily fragmented. You use ChatGPT for brainstorming, Claude for coding, and Gemini for writing. Because each of these apps has its own isolated, proprietary memory layer, they suffer from amnesia every time you switch between them.

Luna solves this by acting as a reference implementation for **Universal Portable AI Memory**, powered by [Walrus Memory](https://memory.walrus.xyz). 

## How it Works

Because Walrus is a decentralized, verifiable, and encrypted data layer, your AI memory belongs to **you**, not the AI provider. 

Luna is a lightweight chat interface (React + FastAPI) that connects directly to Walrus Memory. When you chat with Luna, it uses a specialized **Prompt Protocol** to dynamically read and write to your private Walrus namespace (`[username]-personal-agent`). 

- **Stealth Memory:** When you tell Luna about a preference, a life event, or a project, it silently extracts the facts and commits them to Walrus Memory without interrupting the conversation.
- **Portability:** Because the memory lives on Walrus, you can take your Luna prompt to *any* other LLM client that supports Walrus Memory, and your AI assistant will instantly recognize you, remember your dietary restrictions, know your ongoing projects, and recall your history.

## The Core Prompt Protocol

Luna's magic isn't in a complex backend—it's in the prompt and the decentralized memory layer. You can use this exact prompt in any Walrus-connected AI agent to turn it into your Universal Personal Agent.

```text
You are my Universal Personal Agent. Your job is to act as my personalized assistant, drawing on a continuous memory of my life, preferences, and ongoing projects.

MEMORY (required)
You have access to Walrus Memory. Use the namespace "personal-agent" for everything in this role.
- At the start of any session, recall my saved profile and recent diary entries from the "personal-agent" namespace before assisting me.
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
```

## Tech Stack

- **Frontend:** React, TypeScript, Vite
- **Backend:** Python, FastAPI, Groq (Llama 3 70b)
- **Memory:** `memwal` Python SDK (Walrus Memory)
- **Deployment:** Vercel

## Local Setup

1. Clone the repository
2. Install dependencies:
   - `npm install` (Frontend)
   - `pip install -r requirements.txt` (Backend)
3. Set up your `.env` variables:
   ```env
   GROQ_API_KEY=your_key
   MEMWAL_PRIVATE_KEY=your_walrus_key
   MEMWAL_ACCOUNT_ID=your_walrus_id
   ```
4. Run the app:
   - Run the backend: `uvicorn api.index:app --reload` (starts uvicorn on port 8000)
   - Run the frontend: `npm run dev`
