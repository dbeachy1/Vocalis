import hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[1]); m=json.loads(Path(sys.argv[2]).read_text()); rows=m["files"]; paths=set()
for r in rows:
 p=root/r["path"]; paths.add(r["path"])
 if not p.is_file() or p.stat().st_size!=r["bytes"]: raise SystemExit("source missing/size mismatch: "+r["path"])
 h=hashlib.sha256(p.read_bytes()).hexdigest()
 if h!=r["sha256"]: raise SystemExit("source SHA mismatch: "+r["path"])
if {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}!=paths: raise SystemExit("unexpected source file")
t=hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(",",":")).encode()).hexdigest()
if t!=m["tree_sha256"]: raise SystemExit("source-tree SHA mismatch")
print(json.dumps({"status":"verified","file_count":len(rows),"tree_sha256":t},sort_keys=True))
