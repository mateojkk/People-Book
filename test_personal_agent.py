import asyncio, os
from dotenv import load_dotenv
load_dotenv()
from memwal import MemWal
memwal = MemWal.create(
    key=os.environ["MEMWAL_PRIVATE_KEY"],
    account_id=os.environ["MEMWAL_ACCOUNT_ID"],
    server_url=os.environ.get("MEMWAL_SERVER_URL", "https://relayer.memory.walrus.xyz")
)
async def run():
    print("Testing read/write on personal-agent namespace...")
    ns = "testuser-personal-agent"
    await memwal.remember("I love programming in Python and using Walrus Memory.", namespace=ns)
    print("Wrote memory.")
    await asyncio.sleep(2)
    res = await memwal.recall("programming", limit=12, namespace=ns)
    print("RECALL RES:", [r.text for r in res.results])
asyncio.run(run())
