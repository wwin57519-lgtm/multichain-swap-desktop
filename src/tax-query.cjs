const {Contract,FetchRequest,JsonRpcProvider,formatUnits,getAddress,toQuantity}=require('ethers');
const CONFIG=require('./config.cjs');
const DEX=require('./dex.cjs');
const CONTRACTS=require('./contract-artifacts.cjs');
const TOKEN_ABI=['function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)'];
// Never search nested untrusted token errors for a forged TaxReport.
function revertData(error){
  for(const data of [error?.data?.data,error?.data,error?.info?.error?.data?.result,error?.info?.error?.data]){
    if(typeof data==='string'&&/^0x[0-9a-f]*$/i.test(data))return data;
  }
  return null;
}
function lossPercent(expected,actual){
  expected=BigInt(expected);actual=BigInt(actual);
  if(expected===0n)return null;
  if(actual>=expected)return '0';
  const bps=(expected-actual)*10000n/expected;
  return bps===0n?'<0.01':formatUnits(bps,2);
}
async function queryTax(engine,args,{address,amount,percentage,safeError}){
  const unavailable=reason=>({status:'unavailable',reason});
  if(engine.taxInFlight)return unavailable('已有税率查询正在进行，完成后可查询最新参数');
  if(engine.busy)return unavailable('正在处理管理员操作，完成后自动查询');
  if(!engine.provider||!engine.rpcUrl)return unavailable('请先连接自己的 Base RPC，再自动查询税率');
  if(!engine.wallet)return unavailable('请先在本机加载管理员钱包');
  if(!engine.contractAddress)return unavailable('请先部署或加载新版执行合约；税率查询需要模拟实际买入路径');
  const owner=engine.wallet.address,target=engine.contractAddress,rpcUrl=engine.rpcUrl,chain=engine.chain||CONFIG,generation=engine.contextGeneration;
  const contextCurrent=()=>!engine.closed&&engine.contextGeneration===generation&&(engine.chain||CONFIG).chainId===chain.chainId&&engine.wallet?.address===owner&&engine.contractAddress===target&&engine.rpcUrl===rpcUrl;
  let p;engine.taxInFlight=true;
  try{
    const tokenIn=address(args.tokenIn,'支付代币地址'),tokenOut=address(args.tokenOut,'获得代币地址');
    if(tokenIn===tokenOut)throw Error('支付与获得代币不能相同');
    const recipient=address(args.recipient||owner,'最终收款地址');
    if(recipient===target)throw Error('收款地址不能是执行合约自身');
    const probeBps=percentage(args.testSellPercent??1,'模拟试卖比例');
    if(probeBps===0)throw Error('税率查询需要大于 0 的试卖比例');
    const fees=args.v3Fees??DEX.defaultFees(args.dex??0);
    if(!Array.isArray(fees)||fees.length>8||fees.some(f=>!Number.isInteger(f)||f<=0||f>=1000000)||new Set(fees).size!==fees.length)throw Error('V3 费率配置无效');
    const selected=DEX.venue(args.dex??0);
    if(args.allowV2!==true&&fees.length===0)throw Error('普通池和集中流动性池不能同时关闭');
    // Separate read-only connection, never part of the trigger broadcast queue.
    // Provider-side account quotas still apply to both connections.
    if(engine.taxProviderFactory)p=engine.taxProviderFactory(rpcUrl);
    else{const request=new FetchRequest(rpcUrl);request.timeout=12000;p=new JsonRpcProvider(request,undefined,{batchMaxCount:1,cacheTimeout:-1});}
    if(BigInt((await p.getNetwork()).chainId)!==BigInt(chain.chainId))throw Error('税率查询节点不是当前网络 '+chain.network);
    const blockNumber=await p.getBlockNumber(),blockTag=toQuantity(blockNumber);
    const code=await p.getCode(target,blockNumber),matched=CONTRACTS.identifyExecutor(code,engine.artifact);
    if(!matched)throw Error('此执行合约不支持税率查询，请使用部署工具部署新合约');
    const c=new Contract(target,matched.artifact.abi,p),overrides={blockTag:blockNumber};
    if(selected===2&&!c.interface.hasFunction('getPancakeConfig'))throw Error('旧合约不支持 PancakeSwap');if(selected===1&&!DEX.modern(c))throw Error('旧合约不能模拟 Aerodrome，请先部署新版合约');
    if(getAddress(await c.owner(overrides))!==owner)throw Error('当前管理员不是该执行合约的所有者');
    await DEX.validateDependencies(c,p,matched.helpers,overrides,chain);
    const ticks=await DEX.candidates(p,selected,args.onlyClassic===true||fees.length===0,overrides,chain);
    const input=new Contract(tokenIn,TOKEN_ABI,p),output=new Contract(tokenOut,TOKEN_ABI,p);
    const [di,do_,balance]=await Promise.all([input.decimals(overrides),output.decimals(overrides),input.balanceOf(target,overrides)]);
    for(const d of [di,do_])if(d<0n||d>77n)throw Error('代币精度不支持，无法测定税率');
    let n=amount(args.amountIn,Number(di),'模拟支付数量');if(n===0n)n=balance;
    if(n===0n)throw Error('执行合约没有支付代币余额；充值后将按本轮金额自动模拟');
    if(n>balance)throw Error('执行合约支付余额不足以模拟本轮金额');
    const settings={tokenIn,tokenOut,recipient,minPoolInput:0n,minBuyAmount:0n,allowV2:args.allowV2===true,checkBurn:false,maxBurnBps:10000,testSell:true,testSellBps:probeBps};
    if(!contextCurrent()||engine.busy)return unavailable('钱包、合约或操作状态已变化，等待重新查询');
    const data=DEX.modern(c)?c.interface.encodeFunctionData('simulateTaxWithDex',[settings,fees,n,selected,ticks]):c.interface.encodeFunctionData('simulateTax',[settings,fees,n]);
    const tx={from:owner,to:target,data,gas:toQuantity(12000000)};
    let parsed;
    try{await p.send('eth_call',[tx,blockTag]);throw Error('节点未返回预期的模拟回滚报告，无法测定税率');}
    catch(error){
      const data=revertData(error);if(data)try{parsed=engine.iface.parseError(data);}catch{}
      if(parsed?.name==='TaxSimulationFailed'){
        let cause;try{cause=engine.iface.parseError(parsed.args[0]);}catch{}
        const reasons={NoEligiblePool:'没有可报价的直接池：可能尚未加入流动性',InsufficientInput:'执行合约支付余额不足',SellProbeFailed:'本次试卖无法获得有效回款',UnexpectedBalance:'代币余额变化异常',MinimumNotMet:'本次模拟未获得有效代币'};
        return unavailable(reasons[cause?.name]||'本次买入、试卖或转发模拟失败；可能尚未开盘、禁止交易或节点不支持，税率未知');
      }
      if(parsed?.name!=='TaxReport')throw error;
    }
    if(!contextCurrent())return unavailable('钱包或合约已切换，旧税率结果已丢弃');
    const r=parsed.args;
    if(r.amountIn!==n||r.expectedBuy===0n||r.bought===0n||r.probeAmount===0n||r.expectedSell===0n||r.probeAmount>r.bought)throw Error('模拟报告数值异常，无法测定税率');
    return {status:'ok',blockNumber,queriedAt:new Date().toISOString(),tokenIn,tokenOut,recipient,amountIn:formatUnits(n,di),probePercent:formatUnits(probeBps,2),
      buyLossPercent:lossPercent(r.expectedBuy,r.bought),sellLossPercent:lossPercent(r.expectedSell,r.recovered),transferLossPercent:lossPercent(r.forwarded,r.received),totalBuyLossPercent:lossPercent(r.expectedRecipient,r.received),
      route:DEX.route(r),dex:selected,
      report:Object.fromEntries(['amountIn','expectedBuy','bought','probeAmount','expectedSell','recovered','forwarded','expectedRecipient','received'].map(k=>[k,String(r[k])]))};
  }catch(error){return unavailable(safeError(error,engine.iface));}
  finally{try{p?.destroy?.();}catch{}engine.taxInFlight=false;}
}
module.exports={queryTax,lossPercent,revertData};
