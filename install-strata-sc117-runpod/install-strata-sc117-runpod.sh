#!/usr/bin/env bash
# Run on the RunPod Linux GPU Pod, not on Windows.
# Source: Strata v0.1.45; model: the same SC117 revision verified in this chat.
set -Eeuo pipefail
umask 077
trap 'echo "Installation stopped at line $LINENO. Fix the reported error and run this same script again." >&2' ERR

ROOT=/workspace/strata-sc117
APP="$ROOT/Strata"
DATA="$ROOT/data"
export ROOT APP DATA
export HF_HOME="$ROOT/cache/huggingface"
export HF_XET_CHUNK_CACHE_SIZE_BYTES=0
export PIP_CACHE_DIR="$ROOT/cache/pip"
export PYTHONUNBUFFERED=1
export STRATA_CONTEXT="${STRATA_CONTEXT:-65536}"
SOURCE_COMMIT=477ac13cbe8e582c20484871ce459d20d82df09d

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Use the Linux x86_64 RunPod terminal.'; exit 1; }
[[ -d /workspace ]] || { echo 'Mount your persistent volume at /workspace first.'; exit 1; }
command -v nvidia-smi >/dev/null || { echo 'No NVIDIA GPU detected.'; exit 1; }
command -v python3 >/dev/null || { echo 'Use the RunPod PyTorch Ubuntu image described in the instructions.'; exit 1; }
command -v nvcc >/dev/null || { echo 'CUDA compiler missing. Use runpod/pytorch:1.0.3-cu1300-torch291-ubuntu2404.'; exit 1; }
nvcc --version | grep -q 'release 13\.' || { echo 'CUDA Toolkit 13 is required by this script.'; exit 1; }
python3 - <<'PY'
import os, pathlib, subprocess
lines = subprocess.check_output(['nvidia-smi','--query-gpu=name,driver_version,memory.total','--format=csv,noheader'],text=True).strip().splitlines()
print('GPU:',lines[0],flush=True)
assert int(lines[0].split(',')[1].strip().split('.')[0]) >= 580, 'Select a host with NVIDIA driver 580 or newer / CUDA 13 support.'
ram = os.sysconf('SC_PHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
for name in ('/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory/memory.limit_in_bytes'):
    p=pathlib.Path(name)
    if p.exists() and p.read_text().strip().isdigit(): ram=min(ram,int(p.read_text().strip()))
assert ram >= 44_000_000_000, 'This setup expects at least 44 GB of allocated system RAM (the selected A6000 host had 50 GB).'
PY

if [[ $EUID -eq 0 ]]; then PRIV=(); else command -v sudo >/dev/null; PRIV=(sudo); fi
"${PRIV[@]}" apt-get update
"${PRIV[@]}" apt-get install -y --no-install-recommends git curl ca-certificates build-essential python3-venv libgomp1 libatomic1 util-linux
mkdir -p "$ROOT" "$DATA" "$ROOT/logs"
exec 9>"$ROOT/install.lock"
flock -n 9 || { echo 'Another installation is already running.'; exit 1; }
if [[ -f "$ROOT/server.pid" ]] && kill -0 "$(cat "$ROOT/server.pid")" 2>/dev/null; then
    echo "Stop this installation's server with bash $ROOT/stop.sh before reinstalling."; exit 1
fi

echo '=== 1/5: Download pinned Strata source ==='
if [[ ! -e "$APP" ]]; then
    mkdir -p "$APP"
    git -C "$APP" init -q
fi
[[ -d "$APP/.git" ]] || { echo "$APP already exists but is not this install's Git checkout."; exit 1; }
if ! git -C "$APP" rev-parse --verify HEAD >/dev/null 2>&1; then
    git -C "$APP" fetch --depth 1 https://github.com/Niko1221/Strata.git "$SOURCE_COMMIT"
    git -C "$APP" checkout --detach FETCH_HEAD
fi
[[ "$(git -C "$APP" rev-parse HEAD)" == "$SOURCE_COMMIT" ]] || { echo 'Existing source version differs; nothing was reset.'; exit 1; }
git -C "$APP" diff --quiet && git -C "$APP" diff --cached --quiet || { echo 'Existing source has edits; inspect them before installing.'; exit 1; }
[[ -x "$APP/.venv/bin/python" ]] || python3 -m venv "$APP/.venv"
PY="$APP/.venv/bin/python"
export PY
export PATH="$APP/.venv/bin:$PATH"
"$PY" -m pip install --upgrade pip
"$PY" -m pip install -r "$APP/requirements.txt" 'huggingface_hub>=1,<2'

echo '=== 2/5: Download SC117 IQ2_XS, vision projector and MTP runtime; verify SHA-256 ==='
"$PY" - <<'PY'
import hashlib,json,os,pathlib,shutil
from huggingface_hub import hf_hub_download
root=pathlib.Path(os.environ['ROOT']); data=pathlib.Path(os.environ['DATA'])
dest=data/'downloads'/'sc117'; dest.mkdir(parents=True,exist_ok=True)
repo='SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF'
rev='eec4e10a2c29b440a2ae85591fa11569ce752963'
files=[
 ('IQ2_XS/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ2_XS-00001-of-00002.gguf',39665015072,'4acc3ebb5050d20117bdc77fc39200e709dfe2b2367f3522c95b9112a30aff81'),
 ('IQ2_XS/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ2_XS-00002-of-00002.gguf',28800138432,'316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113'),
 ('mmproj-Qwen3.8-Flash-Next-BF16.gguf',907542944,'2e788f8c511d8093c7b43cb87b2fd7e14228340318057f8fb20c86df2efe2355'),
 ('strata/rt/dense.bin',116099072,'c724dc0b0822ada5d2977bf5bde821605feabaa64ea2e0045b67ca656329070a'),
 ('strata/rt/dense.txt',1880,'8773c81ebb0986e37fe94a8a9933e87be48b1fabc6889a0106bcdab179d1c2ac'),
 ('strata/rt/draft_vocab.bin',425196,'b1e1d3a7a9e4bf862dcd5923ce661fb59bbd07907e594df5cf86a62ac235cb91'),
 ('strata/rt/experts.bin',707788800,'09398406be61f1f54c93861f449e48b8df0bfccbc9ec9b2b7636775a6ea9244f')]
missing=sum(max(0,size-(dest/name).stat().st_size) if (dest/name).is_file() else size for name,size,_ in files)
assert shutil.disk_usage(dest).free >= missing+12_000_000_000, 'Not enough free volume space; allocate at least 120 GB for a fresh install.'
marker=dest/'verified-downloads.json'
old=json.loads(marker.read_text()) if marker.exists() else {}
records={}
for name,size,sha in files:
    path=pathlib.Path(hf_hub_download(repo_id=repo,filename=name,revision=rev,local_dir=dest))
    stat=path.stat(); signature={'sha256':sha,'size':stat.st_size,'mtime_ns':stat.st_mtime_ns}
    assert stat.st_size==size, f'Wrong size: {name}'
    if old.get(name)!=signature:
        print('Verifying SHA-256:',name,flush=True)
        digest=hashlib.sha256()
        with path.open('rb') as f:
            for block in iter(lambda:f.read(16*1024**2),b''): digest.update(block)
        assert digest.hexdigest()==sha, f'SHA-256 mismatch: {name}. Preserve the file for inspection; do not start it.'
    records[name]=signature
    marker.write_text(json.dumps(records,indent=2)+'\n')
rt=data/'mtp'/'rt'; rt.mkdir(parents=True,exist_ok=True)
for name,size,sha in files:
    if not name.startswith('strata/rt/'): continue
    target=rt/pathlib.Path(name).name
    # These are derived runtime files; keep an existing runtime prepared by setup.
    if not target.exists(): shutil.copyfile(dest/name,target)
(root/'model-provenance.json').write_text(json.dumps({'repository':repo,'revision':rev,'files':records},indent=2)+'\n')
print('All published files verified.',flush=True)
PY

echo '=== 3/5: Compile engine and create an independent native pack ==='
cd "$APP"
# Bound compiler concurrency even if the container reports the host's many CPU cores.
# This changes only this setup process; no Strata source file is patched.
"$PY" - --setup --yes --family qwen --model IQ2_XS \
    --gguf-dir "$DATA/downloads/sc117/IQ2_XS" \
    --models-dir "$DATA/downloads/sc117" --data-dir "$DATA" \
    --context "$STRATA_CONTEXT" --gpu 0 --cuda 13 --vision gpu \
    --kv int8 --kv-streaming on --vram-reserve-mib 1536 \
    --low-ram off --experimental-speed-projection off \
    --host 127.0.0.1 --port 8080 --no-browser --no-start <<'PY'
import os,runpy,sys
os.cpu_count=lambda:8
sys.argv=['setup.py',*sys.argv[1:]]
runpy.run_path('setup.py',run_name='__main__')
PY

echo '=== 4/5: Save authenticated SC117 configuration and start/stop commands ==='
"$PY" - <<'PY'
import json,os,pathlib,secrets
root=pathlib.Path(os.environ['ROOT']); app=pathlib.Path(os.environ['APP'])
source=app/'strata-iq2_xs.json'; cfg=json.loads(source.read_text())
native=cfg['args'][cfg['args'].index('--native')+1]
assert '/sc117/IQ2_XS/' in native and 'abliterated' in native, f'Unexpected model: {native}'
assert (pathlib.Path(cfg['tokenizer']).parent/'native_experts.txt').is_file(), 'Native pack incomplete'
keyfile=root/'api-key.txt'
if not keyfile.exists(): keyfile.write_text(secrets.token_urlsafe(36)+'\n')
key=keyfile.read_text().strip()
assert len(key)>=24, 'Existing API key is too short'
cfg.update(model_name='qwen3.8-flash-next-sc117-abliterated-iq2_xs',host='0.0.0.0',port=8080,api_key=key,
           log=str(root/'logs'/'engine.log'))
config=root/'strata-sc117-iq2_xs.json'
config.write_text(json.dumps(cfg,indent=2)+'\n')
keyfile.chmod(0o600);config.chmod(0o600)
(root/'start.sh').write_text('''#!/usr/bin/env bash
set -euo pipefail
ROOT=/workspace/strata-sc117
if [[ -f "$ROOT/server.pid" ]]; then
    old_pid=$(cat "$ROOT/server.pid")
    if [[ "$old_pid" != "$$" ]] && kill -0 "$old_pid" 2>/dev/null; then
        echo "A recorded server process is already running (PID $old_pid)."; exit 1
    fi
fi
echo $$ > "$ROOT/server.pid"
cd /workspace/strata-sc117/Strata
exec .venv/bin/python -u serve/server.py --engine strata --config /workspace/strata-sc117/strata-sc117-iq2_xs.json --host 0.0.0.0 --port 8080
''')
(root/'stop.sh').write_text('''#!/usr/bin/env bash
set -euo pipefail
cd /workspace/strata-sc117
Strata/.venv/bin/python - <<'STOPPY'
import pathlib,psutil,requests,signal
root=pathlib.Path('/workspace/strata-sc117');pidfile=root/'server.pid'
if not pidfile.exists(): print('No recorded server.');raise SystemExit(0)
try: p=psutil.Process(int(pidfile.read_text()))
except psutil.NoSuchProcess: print('Already stopped.');raise SystemExit(0)
assert str(root/'strata-sc117-iq2_xs.json') in p.cmdline(), 'PID belongs to another process; not stopping it.'
key=(root/'api-key.txt').read_text().strip()
r=requests.post('http://127.0.0.1:8080/unload',json={},headers={'Authorization':'Bearer '+key},timeout=90)
r.raise_for_status()
p.send_signal(signal.SIGTERM)
try: p.wait(timeout=90)
except psutil.TimeoutExpired: raise SystemExit('Shutdown still in progress; inspect logs/server.log. No forced kill was issued.')
pidfile.unlink(missing_ok=True);print('SC117 stopped.')
STOPPY
''')
for name in ('start.sh','stop.sh'): (root/name).chmod(0o700)
PY

echo '=== 5/5: Start server and verify a real response ==='
"$PY" - <<'PY'
import json,os,pathlib,socket,subprocess,time
import requests
root=pathlib.Path(os.environ['ROOT']);port=8080
with socket.socket() as sock:
    assert sock.connect_ex(('127.0.0.1',port))!=0, 'Port 8080 is already occupied; the other service was not stopped.'
with (root/'logs'/'server.log').open('ab',buffering=0) as log:
    proc=subprocess.Popen(['bash',str(root/'start.sh')],cwd=root,stdout=log,stderr=subprocess.STDOUT,
                          stdin=subprocess.DEVNULL,start_new_session=True)
(root/'server.pid').write_text(str(proc.pid)+'\n')
base='http://127.0.0.1:8080';deadline=time.monotonic()+600
last_notice=0
while time.monotonic()<deadline:
    if proc.poll() is not None: raise SystemExit('Server exited. Inspect '+str(root/'logs'/'server.log'))
    try:
        r=requests.get(base+'/health',timeout=4);health=r.json()
        if r.ok and health.get('loaded'):
            assert health.get('model')=='qwen3.8-flash-next-sc117-abliterated-iq2_xs',health
            print('Model loaded; context:',health.get('max_context'),flush=True);break
    except (requests.RequestException,ValueError): pass
    if time.monotonic()-last_notice>=20:
        print('Loading model; see /workspace/strata-sc117/logs/engine.log',flush=True);last_notice=time.monotonic()
    time.sleep(3)
else: raise SystemExit('Server is still loading after 10 minutes; process left running. Inspect logs before retrying.')
headers={'Authorization':'Bearer '+(root/'api-key.txt').read_text().strip()}
unauth=requests.get(base+'/v1/models',timeout=10)
assert unauth.status_code in (401,403), 'API is not enforcing authentication; inspect the configuration.'
r=requests.get(base+'/v1/models',headers=headers,timeout=10);r.raise_for_status()
r=requests.post(base+'/v1/chat/completions',headers=headers,json={
 'model':'qwen3.8-flash-next-sc117-abliterated-iq2_xs',
 'messages':[{'role':'user','content':'What is 17 + 25? Reply with the number only.'}],
 'max_tokens':32,'reasoning_effort':'none','temperature':0},timeout=180)
r.raise_for_status();result=r.json();answer=result['choices'][0]['message'].get('content','')
assert '42' in answer, result
print('Generation verified:',answer,flush=True)
(root/'installation-result.json').write_text(json.dumps({'health':health,'generation':result,'authentication_verified':True},indent=2)+'\n')
PY

echo
echo 'INSTALLATION COMPLETE. Open the Pod Connect page -> HTTP service 8080.'
echo 'API base URL: https://YOUR-POD-ID-8080.proxy.runpod.net/v1'
echo 'Model: qwen3.8-flash-next-sc117-abliterated-iq2_xs'
echo 'Show your API key: cat /workspace/strata-sc117/api-key.txt'
echo 'Stop: bash /workspace/strata-sc117/stop.sh'
echo 'Start next time: nohup bash /workspace/strata-sc117/start.sh > /workspace/strata-sc117/logs/server.log 2>&1 &'
