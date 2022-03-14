# TPU Client

Send transactions straight to the TPU Leaders.  
This is a port of solana's rust tpu_client

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

```ts
const rpcurl = 'https://api.mainnet-beta.solana.com';
const tpuConnection = TpuConnection.load(rpcurl, { commitment: 'processed' });

(async () => {
    let tx = new Transaction();
    tx.add(instruction);
    tx.recentBlockhash = (await tpuConnection.getRecentBlockhash()).blockhash;
    tx.feePayer = wallet.payer
    tx = await wallet.signTransaction(tx);
    const signature = await tpuConnection.sendRawTransaction(tx.serialize());
})();

```
