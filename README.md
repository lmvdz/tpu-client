# TPU Client
```
yarn install
yarn build
```

```ts
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