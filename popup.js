const btnStart = document.getElementById('btn-start');
const statusVal = document.getElementById('status-val');
const logBox = document.getElementById('log-box');

let currentStatus = 'idle'; // 'idle' or 'running'

function addLog(message, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
  entry.textContent = `[${timeStr}] ${message}`;
  logBox.appendChild(entry);
  logBox.scrollTop = logBox.scrollHeight;
}

function updateStatus(status) {
  currentStatus = status;
  if (status === '実行中') {
    statusVal.textContent = '実行中';
    statusVal.className = 'status-value running';
    btnStart.textContent = '自動実行を強制停止する';
    btnStart.className = 'btn-main stop-btn';
    btnStart.disabled = false;
  } else {
    statusVal.textContent = '待機中';
    statusVal.className = 'status-value idle';
    btnStart.textContent = '一括自動実行を開始';
    btnStart.className = 'btn-main';
    btnStart.disabled = false;
  }
}

// 状態とログの同期
chrome.runtime.sendMessage({ action: 'getState' }, (response) => {
  if (response) {
    updateStatus(response.status === 'running' ? '実行中' : '待機中');
    if (response.logs && response.logs.length > 0) {
      logBox.innerHTML = '';
      response.logs.forEach(log => {
        const entry = document.createElement('div');
        entry.className = `log-entry ${log.type}`;
        entry.textContent = log.text;
        logBox.appendChild(entry);
      });
      logBox.scrollTop = logBox.scrollHeight;
    }
  }
});

btnStart.addEventListener('click', () => {
  if (currentStatus === '実行中') {
    btnStart.disabled = true;
    btnStart.textContent = '停止中...';
    addLog('自動実行を強制停止します...', 'warn');
    chrome.runtime.sendMessage({ action: 'stop' });
  } else {
    updateStatus('実行中');
    addLog('自動実行プロセスを開始します...', 'info');
    chrome.runtime.sendMessage({ action: 'start' });
  }
});

// バックグラウンドからのログ等のメッセージ受信
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'log') {
    addLog(message.text, message.type);
  } else if (message.action === 'statusChanged') {
    updateStatus(message.status === 'running' ? '実行中' : '待機中');
  }
});
