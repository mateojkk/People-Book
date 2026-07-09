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
    res = await memwal.recall("poem", limit=12)
    print("RECALL RES:", res.results)
asyncio.run(run())
