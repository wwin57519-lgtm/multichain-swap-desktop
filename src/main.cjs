const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Engine, safeError } = require('./engine.cjs');
const { LocalStore } = require('./local-store.cjs');

// Explicit release verification uses a fresh temporary profile and never signs/broadcasts.
const smoke = (!app.isPackaged && process.argv.includes('--smoke-test')) || process.argv.includes('--verify-startup');
const root = path.resolve(__dirname, '..');
const smokeDir=smoke&&app.isPackaged?fs.mkdtempSync(path.join(app.getPath('temp'),'base-swap-package-smoke-')):path.join(root,'verification');
if (smoke) app.setPath('userData', app.isPackaged?path.join(smokeDir,'profile'):path.join(root, '.smoke-user-data'));
app.setAppUserModelId('local.base.uniswap.executor');
const page = pathToFileURL(path.join(root, 'renderer', 'index.html')).href;
let window, engine, closing = false;

function emit(event) {
  if (window && !window.isDestroyed()) window.webContents.send('desktop:event', event);
}

async function start() {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const store = new LocalStore(path.join(app.getPath('userData'), 'state.json'), safeStorage);
  engine = new Engine({ store, onEvent: emit, openExternal: url => shell.openExternal(url), confirmTransaction: async details => {
    if(closing||!window||window.isDestroyed())return false;
    const result=await dialog.showMessageBox(window,{
      type:'question',title:'确认管理员交易',message:details.summary,
      detail:`网络：${details.network}（${details.chainId}）\n发送钱包：${details.from}\n目标：${details.to||'部署新合约'}\n发送 ${details.nativeSymbol}：${details.valueEth}\nNonce：${details.nonce}\nGas 数量上限：${details.gasLimit}\n每 Gas 费率上限：${details.feeCapGwei} gwei\n执行费用上限：${details.maximumExecutionFeeEth} ${details.nativeSymbol}\n\n${details.additionalFeeNotice}`,
      buttons:['取消','确认签名并发送'],defaultId:0,cancelId:0,noLink:true
    });
    return !closing&&result.response===1;
  } });
  ipcMain.handle('desktop:invoke', async (event, method, args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== page) {
      return { ok: false, error: '拒绝未知页面的请求' };
    }
    try {
      if (typeof method !== 'string' || !args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 65536) throw Error('请求格式无效');
      return { ok: true, value: await engine.invoke(method, args) };
    } catch (error) { return { ok: false, error: safeError(error, engine.iface) }; }
  });
  window = new BrowserWindow({
    width: 1280, height: 960, minWidth: 980, minHeight: 720,
    title: 'MultiChain Swap Desktop', backgroundColor: '#f4f7fb', show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, devTools: !app.isPackaged }
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => { if (!smoke) window.show(); });
  await window.loadURL(page);
  if (smoke) await smokeTest();
}

async function smokeTest() {
  const result = await window.webContents.executeJavaScript(`(async () => {
    const info = await window.desktop.invoke('app.info');
    let rejected = false;
    try { await window.desktop.invoke('not.allowed', {}); } catch { rejected = true; }
    let wrongRpcRejected = false;
    try { await window.desktop.invoke('rpc.connect', {url:'http://example.com/'}); } catch { wrongRpcRejected = true; }
    const privateTestKey='0x'+'01'.repeat(32);
    const imported=await window.desktop.invoke('wallet.import',{privateKey:privateTestKey});
    const afterImport=await window.desktop.invoke('app.info');
    const localWalletImported=/^0x[0-9a-f]{40}$/i.test(imported.address)&&afterImport.wallet?.address===imported.address;
    const privateKeyNotReturned=!JSON.stringify([imported,afterImport]).includes(privateTestKey.slice(2));
    await window.desktop.invoke('wallet.disconnect');
    const afterLock=await window.desktop.invoke('app.info');
    const localWalletLocked=afterLock.wallet===null&&afterLock.rpcUrl==='';
    const networkSwitches=[];for(const id of [1,56,8453]){const select=document.getElementById('network-select');select.value=String(id);select.dispatchEvent(new Event('change',{bubbles:true}));let info;for(let n=0;n<100;n++){await new Promise(r=>setTimeout(r,20));info=await window.desktop.invoke('app.info');if(info.chainId===id&&!select.disabled)break;}networkSwitches.push({requested:id,actual:info.chainId,nativeSymbol:info.nativeSymbol,contractCleared:!info.contractAddress&&!info.contract,uiChain:Number(select.value),uiNetwork:document.getElementById('network-context').textContent,withdrawLabel:document.getElementById('withdraw-eth-button').textContent});}await new Promise(r=>setTimeout(r,1500));const networksPassed=networkSwitches.every(x=>x.actual===x.requested&&x.uiChain===x.requested&&x.contractCleared&&x.withdrawLabel.includes(x.nativeSymbol)&&x.uiNetwork===({1:'Ethereum',56:'BSC',8453:'Base'})[x.requested]);
    const priceChecks=[];
    for(const mode of ['minimum','slippage']){const radio=document.getElementById('price-mode-'+mode);radio.checked=true;radio.dispatchEvent(new Event('change'));priceChecks.push({mode,checked:radio.checked,otherUnchecked:!document.getElementById('price-mode-'+(mode==='minimum'?'slippage':'minimum')).checked,minimumDisabled:document.getElementById('min-buy-amount').disabled,autoDisabled:document.getElementById('trigger-slippage').disabled,manualDisabled:document.getElementById('slippage-percent').disabled});}
    const priceControlsPassed=priceChecks.every(x=>x.checked&&x.otherUnchecked&&x.minimumDisabled===(x.mode==='slippage')&&x.autoDisabled===(x.mode==='minimum')&&x.manualDisabled===(x.mode==='minimum'));
    document.querySelector('.price-protection-choice').scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,500));
    return {independentRecoveryPresent:!!document.getElementById('contract-recovery-load'),priceChecks,priceControlsPassed,networkSwitches,networksPassed,networkDropdown:!!document.getElementById('network-select'),pancakeOption:!!document.querySelector('#dex option[value="2"]'), title:document.title, bridgeReady:!!window.desktop, version:info.version,
      chainId:info.chainId, rpcUrlEmpty:info.rpcUrl === '', walletEmpty:info.wallet === null,
      nodeNotExposed:typeof require === 'undefined' && typeof process === 'undefined',
      rejected, wrongRpcRejected, deployDisabled:document.getElementById('contract-deploy').disabled,
      buyDisabled:document.getElementById('trade-buy').disabled,
      onlyV2Present:!!document.getElementById('only-v2'),
      localWalletImported,privateKeyNotReturned,localWalletLocked,
      overflow:document.documentElement.scrollWidth > innerWidth
    };
  })()`);
  const dir = smokeDir; fs.mkdirSync(dir, {recursive:true});
  result.packaged=app.isPackaged;
  result.security = window.webContents.getLastWebPreferences();
  result.safeStorageAvailable = safeStorage.isEncryptionAvailable();
  result.passed = result.independentRecoveryPresent && result.priceControlsPassed && result.networksPassed && result.pancakeOption && result.bridgeReady && result.chainId === 8453 && result.rpcUrlEmpty && result.walletEmpty && result.nodeNotExposed && result.rejected && result.wrongRpcRejected && result.deployDisabled && result.buyDisabled && result.onlyV2Present && result.localWalletImported && result.privateKeyNotReturned && result.localWalletLocked && !result.overflow;
  fs.writeFileSync(path.join(dir, 'electron-smoke.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(dir, 'desktop-preview.png'), (await window.webContents.capturePage()).toPNG());
  console.log('Electron smoke test: ' + (result.passed ? 'PASS' : 'FAIL'));
  app.exit(result.passed ? 0 : 1);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (closing || !engine) return;
    event.preventDefault(); closing = true; engine.beginShutdown?.();
    // A full disk must not leave the administrator key loaded or trap the application in before-quit.
    Promise.resolve().then(() => engine.persist()).catch(error => console.error(safeError(error)))
      .then(() => engine.close()).catch(error => console.error(safeError(error))).finally(() => app.quit());
  });
  start().catch(error => {
    const message = safeError(error);
    if (!smoke) dialog.showErrorBox('启动失败', message);
    else console.error(message);
    app.exit(1);
  });
}
