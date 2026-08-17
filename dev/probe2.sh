#!/usr/bin/env bash
set -u
jqget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);try{console.log(eval('j.'+process.argv[1]))}catch(e){}})" "$1"; }

echo "=== rename w3:p2 -> mcode ==="
herdr agent rename w3:p2 mcode 2>&1 | head -c 500
echo; echo "=== agent get mcode ==="
herdr agent get mcode 2>&1 | head -c 600
echo; echo "=== prompt (tiny, waits for idle) ==="
herdr agent prompt mcode "Reply with the single word PROBE_OK and nothing else." --wait --timeout 120000 2>&1 | head -c 800
echo; echo "=== read after prompt ==="
herdr agent read mcode --source recent-unwrapped --lines 25 2>&1 | head -c 1200
echo; echo "=== send-keys ctrl+c ==="
herdr agent send-keys mcode ctrl+c 2>&1 | head -c 300
echo; echo "=== close workspace w3 ==="
herdr workspace close w3 2>&1 | head -c 300
echo; echo "=== agents after close ==="
herdr agent list 2>&1 | head -c 900
