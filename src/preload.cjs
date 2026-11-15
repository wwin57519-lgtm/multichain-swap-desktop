const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set([
  'network.select', 'app.info', 'app.openExternal', 'rpc.connect', 'wallet.import', 'wallet.disconnect',
  'token.inspect', 'tax.query', 'contract.load', 'contract.read', 'contract.deploy', 'contract.save',
  'quote.compare', 'trade.simulate', 'trade.buy', 'funds.deposit', 'funds.withdraw',
  'transaction.refresh', 'transaction.recover',
  'trigger.read', 'trigger.wallets', 'trigger.arm', 'trigger.disarm'
]);
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  async invoke(method, args = {}) {
    if (!allowed.has(method)) throw new Error('不支持的操作');
    const result = await ipcRenderer.invoke('desktop:invoke', method, args);
    if (!result.ok) throw new Error(result.error || '操作失败');
    return result.value;
  },
  onEvent(callback) {
    if (typeof callback !== 'function') throw new Error('需要回调函数');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('desktop:event', listener);
    return () => ipcRenderer.removeListener('desktop:event', listener);
  }
}));
