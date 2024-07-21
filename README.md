# TPU (QUIC enabled) Client

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


import { Transaction, Keypair, SystemProgram, ComputeBudgetProgram} from '@solana/web3.js';
import { TpuConnection} from '../src/index';
import { config } from 'dotenv';
import base58 from 'bs58';

config();

const rpcurl = process.env.RPC_URL!;
const signer = Keypair.fromSecretKey(base58.decode(process.env.KEYPAIR!));

(async () => {
    const start = process.hrtime();
    const tpuConnection = await TpuConnection.load(rpcurl, { commitment: 'processed' });
    const tx = new Transaction();
    const instruction = SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: signer.publicKey, lamports: 1 });
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 }));
    tx.add(instruction);
    console.log('sending tx');
    await tpuConnection.sendAndConfirmAbortableTransaction(tx, [signer]);
    const end = process.hrtime(start);
    const timeInMs = (end[0]* 1000000000 + end[1]) / 1000000;
    console.log(timeInMs);
})();


```
