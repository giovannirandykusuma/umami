#!/bin/sh
set -eu
name="analyst-verifier-proof-$$"
image="$name:local"
cleanup() {
  docker rm -f "$name-worker" "$name-app" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker build -f deploy/analyst-verifier/Dockerfile.proof -t "$image" .
docker network create --internal "$name" >/dev/null
gateway=$(docker network inspect "$name" --format '{{(index .IPAM.Config 0).Gateway}}')
docker run -d --name "$name-app" --network "$name" --network-alias fixture --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 256m --tmpfs /tmp:rw,nosuid,nodev,size=16m "$image" node scripts/ai/verifier/container-app.mjs >/dev/null
docker create --name "$name-worker" --network "$name" --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 1g --shm-size 128m --tmpfs /tmp:rw,nosuid,nodev,size=128m -e "PROOF_GATEWAY=$gateway" "$image" >/dev/null
PROOF_NAME="$name" python3 - <<'PY'
import json,os,subprocess
name=os.environ['PROOF_NAME']
read=lambda *args: json.loads(subprocess.check_output(['docker',*args]))[0]
network=read('network','inspect',name)
assert network['Internal'] is True
# Created worker endpoint is attached at start; app must be the only running peer.
assert len(network['Containers']) == 1
for suffix in ('app','worker'):
 c=read('inspect',name+'-'+suffix); h=c['HostConfig']
 assert c['Config']['User']=='10001:10001' and h['ReadonlyRootfs']
 assert h['CapDrop']==['ALL'] and not h['CapAdd'] and not h['Privileged']
 assert 'no-new-privileges' in h['SecurityOpt']
 assert not c['Mounts'] or all(m['Type']=='tmpfs' for m in c['Mounts'])
 assert list(c['NetworkSettings']['Networks']) == [name]
 assert not h['Binds'] and not h['PortBindings']
 print(json.dumps({'container':suffix,'user':c['Config']['User'],'readOnly':h['ReadonlyRootfs'],'capDrop':h['CapDrop'],'securityOpt':h['SecurityOpt'],'networks':list(c['NetworkSettings']['Networks']),'tmpfs':h['Tmpfs'],'memory':h['Memory'],'shm':h['ShmSize']}))
PY
docker start "$name-worker" >/dev/null
PROOF_NAME="$name" python3 - <<'PY'
import json,os,subprocess
n=json.loads(subprocess.check_output(['docker','network','inspect',os.environ['PROOF_NAME']]))[0]
assert n['Internal'] and len(n['Containers']) == 2
assert {v['Name'] for v in n['Containers'].values()} == {os.environ['PROOF_NAME']+'-app',os.environ['PROOF_NAME']+'-worker'}
print('internal network membership: exactly fixture and verifier')
PY
code=$(docker wait "$name-worker")
docker logs "$name-worker"
test "$code" = 0
