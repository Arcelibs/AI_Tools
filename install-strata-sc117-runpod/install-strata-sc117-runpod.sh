#!/usr/bin/env bash
# Run on the RunPod Linux GPU Pod, not on Windows.
# Source: Strata v0.1.45; model: the same SC117 revision verified in this chat.
set -Eeuo pipefail
umask 077
trap 'echo "【安裝中止】腳本第 $LINENO 行執行失敗。請先處理上方錯誤，再執行同一份腳本。" >&2' ERR

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

echo '=== 安裝前檢查：作業系統、GPU、驅動與主記憶體 ==='
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo '請在 RunPod 的 Linux x86_64 終端機執行。'; exit 1; }
[[ -d /workspace ]] || { echo '找不到 /workspace，請先確認儲存空間已掛載到這個路徑。'; exit 1; }
command -v nvidia-smi >/dev/null || { echo '找不到 nvidia-smi，請確認 Pod 已配置 NVIDIA GPU 與驅動。'; exit 1; }
command -v python3 >/dev/null || { echo '找不到 Python 3，請使用說明中的 RunPod PyTorch Ubuntu 映像。'; exit 1; }
command -v nvcc >/dev/null || { echo '缺少 CUDA 編譯器，請使用 runpod/pytorch:1.0.3-cu1300-torch291-ubuntu2404。'; exit 1; }
nvcc --version | grep -q 'release 13\.' || { echo '本腳本需要 CUDA Toolkit 13。'; exit 1; }
python3 - <<'PY'
import os, pathlib, subprocess
lines = subprocess.check_output(['nvidia-smi','--query-gpu=name,driver_version,memory.total','--format=csv,noheader'],text=True).strip().splitlines()
print('GPU／驅動版本／顯示記憶體：',lines[0],flush=True)
assert int(lines[0].split(',')[1].strip().split('.')[0]) >= 580, '請選擇 NVIDIA 驅動 580 以上、支援 CUDA 13 的主機。'
ram = os.sysconf('SC_PHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
for name in ('/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory/memory.limit_in_bytes'):
    p=pathlib.Path(name)
    if p.exists() and p.read_text().strip().isdigit(): ram=min(ram,int(p.read_text().strip()))
print(f'可用主記憶體配額：{ram/1_000_000_000:.1f} GB',flush=True)
assert ram >= 44_000_000_000, '此安裝至少需要 44 GB 主記憶體配額；建議選擇 50 GB 以上的主機。'
PY

if [[ $EUID -eq 0 ]]; then PRIV=(); else command -v sudo >/dev/null; PRIV=(sudo); fi
echo '正在安裝系統工具與編譯環境；下方套件管理工具的原始輸出可能包含英文。'
"${PRIV[@]}" apt-get update
"${PRIV[@]}" apt-get install -y --no-install-recommends git curl ca-certificates build-essential python3-venv libgomp1 libatomic1 util-linux
mkdir -p "$ROOT" "$DATA" "$ROOT/logs"
exec 9>"$ROOT/install.lock"
flock -n 9 || { echo '已有另一個安裝程序正在執行，請勿重複啟動。'; exit 1; }
if [[ -f "$ROOT/server.pid" ]] && kill -0 "$(cat "$ROOT/server.pid")" 2>/dev/null; then
    echo "此安裝的服務仍在執行，重新安裝前請先停止：bash $ROOT/stop.sh"; exit 1
fi

echo '=== 1/5：下載指定版本的 Strata 原始碼與 Python 套件 ==='
if [[ ! -e "$APP" ]]; then
    mkdir -p "$APP"
    git -C "$APP" init -q
fi
[[ -d "$APP/.git" ]] || { echo "$APP 已存在，但不是此安裝所需的 Git 原始碼目錄。"; exit 1; }
if ! git -C "$APP" rev-parse --verify HEAD >/dev/null 2>&1; then
    git -C "$APP" fetch --depth 1 https://github.com/Niko1221/Strata.git "$SOURCE_COMMIT"
    git -C "$APP" checkout --detach FETCH_HEAD
fi
[[ "$(git -C "$APP" rev-parse HEAD)" == "$SOURCE_COMMIT" ]] || { echo '現有原始碼版本與指定版本不同，已停止安裝並保留原有內容。'; exit 1; }
git -C "$APP" diff --quiet && git -C "$APP" diff --cached --quiet || { echo '現有原始碼有修改，請先檢查修改內容再安裝。'; exit 1; }
[[ -x "$APP/.venv/bin/python" ]] || python3 -m venv "$APP/.venv"
PY="$APP/.venv/bin/python"
export PY
export PATH="$APP/.venv/bin:$PATH"
"$PY" -m pip install --upgrade pip
"$PY" -m pip install -r "$APP/requirements.txt" 'huggingface_hub>=1,<2'

echo '=== 2/5：下載 SC117 IQ2_XS、視覺投影器與 MTP 執行檔，並驗證 SHA-256 ==='
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
print(f'儲存空間檢查：剩餘 {shutil.disk_usage(dest).free/1_000_000_000:.1f} GB，本次至少需要 {(missing+12_000_000_000)/1_000_000_000:.1f} GB（含預留空間）。',flush=True)
assert shutil.disk_usage(dest).free >= missing+12_000_000_000, '儲存空間不足；全新安裝請配置至少 120 GB，並確認容量確實掛載在 /workspace。'
marker=dest/'verified-downloads.json'
old=json.loads(marker.read_text()) if marker.exists() else {}
records={}
for name,size,sha in files:
    print(f'正在下載或確認已有檔案：{name}（{size/1_000_000_000:.3f} GB）',flush=True)
    path=pathlib.Path(hf_hub_download(repo_id=repo,filename=name,revision=rev,local_dir=dest))
    stat=path.stat(); signature={'sha256':sha,'size':stat.st_size,'mtime_ns':stat.st_mtime_ns}
    assert stat.st_size==size, f'檔案大小不符：{name}'
    if old.get(name)!=signature:
        print('正在驗證 SHA-256：',name,flush=True)
        digest=hashlib.sha256()
        with path.open('rb') as f:
            for block in iter(lambda:f.read(16*1024**2),b''): digest.update(block)
        assert digest.hexdigest()==sha, f'SHA-256 驗證失敗：{name}。請保留檔案供檢查，暫勿啟動。'
    print('檔案確認完成：',name,flush=True)
    records[name]=signature
    marker.write_text(json.dumps(records,indent=2)+'\n')
rt=data/'mtp'/'rt'; rt.mkdir(parents=True,exist_ok=True)
for name,size,sha in files:
    if not name.startswith('strata/rt/'): continue
    target=rt/pathlib.Path(name).name
    # These are derived runtime files; keep an existing runtime prepared by setup.
    if not target.exists(): shutil.copyfile(dest/name,target)
(root/'model-provenance.json').write_text(json.dumps({'repository':repo,'revision':rev,'files':records},indent=2)+'\n')
print('所有下載檔案皆已通過驗證，MTP 執行檔已準備完成。',flush=True)
PY

echo '=== 3/5：編譯 Strata 引擎，建立 SC117 專用模型 pack ==='
echo '此步驟可能需要較長時間；Strata 與編譯工具的原始日誌會保留，方便排查錯誤。'
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

echo '=== 4/5：儲存 SC117 設定、API 金鑰與啟動／停止腳本 ==='
"$PY" - <<'PY'
import json,os,pathlib,secrets
root=pathlib.Path(os.environ['ROOT']); app=pathlib.Path(os.environ['APP'])
source=app/'strata-iq2_xs.json'; cfg=json.loads(source.read_text())
native=cfg['args'][cfg['args'].index('--native')+1]
assert '/sc117/IQ2_XS/' in native and 'abliterated' in native, f'模型路徑與預期不符：{native}'
assert (pathlib.Path(cfg['tokenizer']).parent/'native_experts.txt').is_file(), '模型 pack 不完整，缺少 native_experts.txt'
keyfile=root/'api-key.txt'
if not keyfile.exists(): keyfile.write_text(secrets.token_urlsafe(36)+'\n')
key=keyfile.read_text().strip()
assert len(key)>=24, '現有 API 金鑰長度不足，至少需要 24 個字元'
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
        echo "已記錄的服務程序仍在執行（PID $old_pid），請勿重複啟動。"; exit 1
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
if not pidfile.exists(): print('找不到已記錄的服務程序。');raise SystemExit(0)
try: p=psutil.Process(int(pidfile.read_text()))
except psutil.NoSuchProcess: print('服務已經停止。');raise SystemExit(0)
assert str(root/'strata-sc117-iq2_xs.json') in p.cmdline(), '此 PID 屬於其他程序，已取消停止操作。'
key=(root/'api-key.txt').read_text().strip()
r=requests.post('http://127.0.0.1:8080/unload',json={},headers={'Authorization':'Bearer '+key},timeout=90)
r.raise_for_status()
p.send_signal(signal.SIGTERM)
try: p.wait(timeout=90)
except psutil.TimeoutExpired: raise SystemExit('服務仍在關閉中，請檢查 logs/server.log；未執行強制終止。')
pidfile.unlink(missing_ok=True);print('SC117 服務已停止。')
STOPPY
''')
for name in ('start.sh','stop.sh'): (root/name).chmod(0o700)
PY

echo '=== 5/5：啟動服務，檢查模型載入、API 驗證與實際生成回應 ==='
"$PY" - <<'PY'
import json,os,pathlib,socket,subprocess,time
import requests
root=pathlib.Path(os.environ['ROOT']);port=8080
with socket.socket() as sock:
    assert sock.connect_ex(('127.0.0.1',port))!=0, '連接埠 8080 已被占用，請先確認占用來源；腳本未停止其他服務。'
with (root/'logs'/'server.log').open('ab',buffering=0) as log:
    proc=subprocess.Popen(['bash',str(root/'start.sh')],cwd=root,stdout=log,stderr=subprocess.STDOUT,
                          stdin=subprocess.DEVNULL,start_new_session=True)
(root/'server.pid').write_text(str(proc.pid)+'\n')
base='http://127.0.0.1:8080';deadline=time.monotonic()+600
last_notice=0
while time.monotonic()<deadline:
    if proc.poll() is not None: raise SystemExit('服務已結束，請檢查日誌：'+str(root/'logs'/'server.log'))
    try:
        r=requests.get(base+'/health',timeout=4);health=r.json()
        if r.ok and health.get('loaded'):
            assert health.get('model')=='qwen3.8-flash-next-sc117-abliterated-iq2_xs',health
            print('模型載入完成，上下文長度：',health.get('max_context'),flush=True);break
    except (requests.RequestException,ValueError): pass
    if time.monotonic()-last_notice>=20:
        print('模型載入中，詳細進度請查看 /workspace/strata-sc117/logs/engine.log',flush=True);last_notice=time.monotonic()
    time.sleep(3)
else: raise SystemExit('等待 10 分鐘後模型仍未就緒，服務程序已保留執行；請先檢查日誌再重試。')
headers={'Authorization':'Bearer '+(root/'api-key.txt').read_text().strip()}
unauth=requests.get(base+'/v1/models',timeout=10)
assert unauth.status_code in (401,403), 'API 未正確要求金鑰驗證，請檢查設定。'
print('API 金鑰驗證檢查通過，正在測試 17 + 25 的生成回應。',flush=True)
r=requests.get(base+'/v1/models',headers=headers,timeout=10);r.raise_for_status()
r=requests.post(base+'/v1/chat/completions',headers=headers,json={
 'model':'qwen3.8-flash-next-sc117-abliterated-iq2_xs',
 'messages':[{'role':'user','content':'What is 17 + 25? Reply with the number only.'}],
 'max_tokens':32,'reasoning_effort':'none','temperature':0},timeout=180)
r.raise_for_status();result=r.json();answer=result['choices'][0]['message'].get('content','')
assert '42' in answer, result
print('生成測試通過，模型回答：',answer,flush=True)
(root/'installation-result.json').write_text(json.dumps({'health':health,'generation':result,'authentication_verified':True},indent=2)+'\n')
PY

echo
echo '【安裝完成】模型載入、API 金鑰驗證與生成測試皆已通過。'
echo '開啟網頁：RunPod 的 Pod 頁面 → Connect → HTTP service 8080。'
echo 'API 基底網址：https://YOUR-POD-ID-8080.proxy.runpod.net/v1（請替換成你的 Pod ID）'
echo '模型名稱：qwen3.8-flash-next-sc117-abliterated-iq2_xs'
echo '查看 API 金鑰：cat /workspace/strata-sc117/api-key.txt'
echo '停止服務：bash /workspace/strata-sc117/stop.sh'
echo '下次啟動：nohup bash /workspace/strata-sc117/start.sh > /workspace/strata-sc117/logs/server.log 2>&1 &'
