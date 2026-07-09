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
    print("Writing...")
    await memwal.remember("This is a test poem: Roses are red, violets are blue, Walrus is great, and so are you.", namespace="decisions")
    print("Wrote memory. Recalling...")
    await asyncio.sleep(2)
    res = await memwal.recall("poem", limit=12)
    print("RECALL RES:", [r.text for r in res.results])
asyncio.run(run())
