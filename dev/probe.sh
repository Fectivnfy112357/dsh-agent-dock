#!/usr/bin/env bash
set -u
jqget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);try{console.log(eval('j.'+process.argv[1]))}catch(e){}})" "$1"; }

WC=$(herdr workspace create --label probe3 --cwd 'D:/programming/projects/dsh_worlspace' 2>&1)
echo "CREATE: $(echo "$WC" | head -c 600)"
WS=$(echo "$WC" | jqget "result.workspace.workspace_id")
echo "WS=$WS"
sleep 1
TAB=$(herdr tab list --workspace "$WS" 2>/dev/null | jqget "result.tabs[0].tab_id")
PANE=$(herdr pane list --workspace "$WS" 2>/dev/null | jqget "result.panes[0].pane_id")
echo "TAB=$TAB PANE=$PANE"
echo "=== split ==="
OUT=$(herdr pane split --pane "$PANE" --direction right --no-focus 2>&1)
echo "$OUT" | head -c 700
NEWPANE=$(echo "$OUT" | jqget "result.pane.pane_id")
echo "NEWPANE=$NEWPANE"
herdr pane run "$NEWPANE" "echo probe-ok" 2>&1 | head -c 300
sleep 1
echo; echo "=== run mcode ==="
herdr pane run "$NEWPANE" "mcode" 2>&1 | head -c 300
sleep 10
echo; echo "=== agents now ==="
herdr agent list 2>&1 | head -c 1500
echo
