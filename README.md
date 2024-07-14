# TPU (QUIC enabled) Client

CURRENTLY WAITING FOR QUIC LIBRARY TO ADD SUPPORT FOR CUSTOM SERVERNAME

-----------------------------------------------------------------------------------------

Send transactions straight to the TPU Leaders.  
This is a port of solana's rust tpu_client.  
Sending transactions straight to TPU leaders can be helpful when the RPC you're using has a rate limit.

# Building from Source

```
yarn install
yarn build
```

# Installation via NPM

```
yarn add tpu-client
```

# Usage  
  
You can use `TpuConnection` just like a @solana/web3.js `Connection` object. In fact `TpuConnection` is just an extension of `Connection`.  
The only thing which is different is that when you use `sendTransaction` and `sendRawTransaction` it sends the transaction to the tpu leader, instead of the `rpcurl` RPC.  

```ts
const rpcurl = 'https://api.mainnet-beta.solana.com';

(async () => {
    const tpuConnection = await TpuConnection.load(rpcurl, { commitment: 'processed' });
    let tx = new Transaction();
    tx.add(instruction);
    tx.recentBlockhash = (await tpuConnection.getRecentBlockhash()).blockhash;
    tx.feePayer = wallet.payer
    tx = await wallet.signTransaction(tx);
    const signature = await tpuConnection.sendRawTransaction(tx.serialize());
})();

```
