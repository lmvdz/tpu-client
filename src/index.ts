import { Commitment, ConfirmOptions, Connection, ConnectionConfig, PublicKey, SendOptions, SignatureResult, Signer, Transaction, TransactionExpiredBlockheightExceededError, TransactionSignature, VersionedTransaction } from "@solana/web3.js";
import { default as Denque } from 'denque';
import {QUICClient} from "@matrixai/quic";
import { default as Logger } from '@matrixai/logger';
import * as peculiarWebcrypto from '@peculiar/webcrypto';
import base58 from "bs58";
import selfsigned from 'selfsigned';

// create self signed pems for quic
const pems = selfsigned.generate([{name: 'commonName', value: 'Solana node'}, { name: "subjectAltName", value: [{ type: 7, value: "0.0.0.0" }]}], { days: 365, algorithm: 'ed25519', keySize: 2048 });

export class LeaderTpuCache {
    leaderTpuMap: Map<string, string>;
    connection: Connection;
    first_slot: number;
    slots_in_epoch: number;
    last_epoch_info_slot: number;
    leaders: Array<PublicKey>;
    private constructor(connection: Connection, startSlot: number) {
        this.connection = connection;
        this.first_slot = startSlot;
    }
    static load(connection : Connection, startSlot: number) : Promise<LeaderTpuCache> {
        return new Promise((resolve) => {
            const leaderTpuCache = new LeaderTpuCache(connection, startSlot);
            leaderTpuCache.connection.getEpochInfo().then(epochInfo => {
                leaderTpuCache.slots_in_epoch = epochInfo.slotsInEpoch;
                leaderTpuCache.fetchSlotLeaders(leaderTpuCache.first_slot, leaderTpuCache.slots_in_epoch).then((leaders) => {
                    leaderTpuCache.leaders = leaders;
                    leaderTpuCache.fetchClusterTpuSockets().then(leaderTpuMap => {
                        leaderTpuCache.leaderTpuMap = leaderTpuMap;
                        resolve(leaderTpuCache);
                    });
                });
            });
        });
        
    }
    fetchClusterTpuSockets() : Promise<Map<string, string>> {
        return new Promise((resolve, reject) => {
            const map = new Map<string, string>();
            this.connection.getClusterNodes().then(contactInfo => {
                contactInfo.forEach(contactInfo => {
                    // @ts-ignore
                    map.set(contactInfo.pubkey, contactInfo.tpuQuic);
                });
                resolve(map);
            }).catch(error => {
                reject(error);
            });
        });   
    }
    fetchSlotLeaders(start_slot: number, slots_in_epoch: number) : Promise<Array<PublicKey>> {
        const fanout = Math.min((2 * MAX_FANOUT_SLOTS), slots_in_epoch);
        return this.connection.getSlotLeaders(start_slot, fanout);
    }
    lastSlot() : number {
        return this.first_slot + this.leaders.length - 1;
    }
    getSlotLeader(slot: number) : PublicKey | null {
        if (slot >= this.first_slot) {
            const index = slot - this.first_slot;
            return this.leaders[index];
        } else {
            return null;
        }
    }
    getLeaderSockets(fanout_slots: number) : Promise<Array<string>> {
        return new Promise((resolve) => {
            const leaderSet = new Set<string>();
            const leaderSockets = new Array<string>();
            let checkedSlots = 0;
            this.leaders.forEach((leader) => {
                const tpu_socket = this.leaderTpuMap.get(leader.toBase58());
                if (tpu_socket !== undefined && tpu_socket !== null) {
                    if (!leaderSet.has(leader.toBase58())) {
                        leaderSet.add(leader.toBase58());
                        leaderSockets.push(tpu_socket);
                    }
                } else {
                    console.log('TPU not available for leader: ', leader.toBase58());
                }
                checkedSlots++;
                if (checkedSlots === fanout_slots) {
                    resolve(leaderSockets);
                }
            });
        });
        
    }
}

export const MAX_SLOT_SKIP_DISTANCE = 48;
export const DEFAULT_FANOUT_SLOTS = 12;
export const MAX_FANOUT_SLOTS = 100;


export class RecentLeaderSlots {
    recent_slots: Denque;

    //@ts-check
    /**
     * 
     * @param current_slot {number}
     */
    constructor(current_slot: number) {
        this.recent_slots = new Denque();
        this.recent_slots.push(current_slot);
    }

    //@ts-check
    /**
     * 
     * @param current_slot {number}
     */
    recordSlot(current_slot: number) {
        this.recent_slots.push(current_slot);
        while(this.recent_slots.length > 12) {
            this.recent_slots.pop();
        }
    }

    //@ts-check
    /**
     * 
     * @returns {number}
     */
    estimatedCurrentSlot() : number {
        if (this.recent_slots.isEmpty()) {
            throw new Error('recent slots is empty');
        }
        const sortedRecentSlots = this.recent_slots.toArray().sort((a, b) => a - b);
        const max_index = sortedRecentSlots.length - 1;
        const median_index = max_index / 2;
        const median_recent_slot = sortedRecentSlots[median_index];
        const expected_current_slot = median_recent_slot + (max_index - median_index);
        const max_reasonable_current_slot = expected_current_slot + MAX_SLOT_SKIP_DISTANCE;
        return sortedRecentSlots.reverse().find(slot => slot <= max_reasonable_current_slot);
    }
}

export interface TpuClientConfig {
    fanoutSlots: number
}


export class TpuClient {
    fanoutSlots: number;
    leaderTpuService: LeaderTpuService;
    exit: boolean;
    connection: Connection;

    //@ts-check
    /**
     * @param connection {Connection}
     * @param config {TpuClientConfig}
     */
    private constructor(connection: Connection, config: TpuClientConfig = { fanoutSlots: DEFAULT_FANOUT_SLOTS }) {
        this.connection = connection;
        this.exit = false;
        this.fanoutSlots = Math.max( Math.min(config.fanoutSlots, MAX_FANOUT_SLOTS), 1 );
        console.log('started tpu client');
    }
    
    //@ts-check
    /**
     * @param connection {Connection}
     * @param websocketUrl {string}
     * @param config {TpuClientConfig}
     * @returns {Promise<TpuClient>}
     */
    static load(connection: Connection, websocketUrl = '', config: TpuClientConfig = { fanoutSlots: DEFAULT_FANOUT_SLOTS }) : Promise<TpuClient> {
        return new Promise((resolve) => {
            const tpuClient = new TpuClient(connection, config);
            LeaderTpuService.load(tpuClient.connection, websocketUrl).then((leaderTpuService) => {
                tpuClient.leaderTpuService = leaderTpuService;
                resolve(tpuClient);
            });
        });
    }

    //@ts-check
    /**
     * @param transaction {Transaction}
     * @param signers {Array<Signer>}
     * @returns {Promise<string>}
     */
    async sendTransaction(transaction: Transaction | VersionedTransaction, signersOrOptions: Array<Signer> | SendOptions, _options?: SendOptions) : Promise<TransactionSignature> {
        if ('version' in transaction) {
            if (signersOrOptions && Array.isArray(signersOrOptions)) {
              throw new Error('Invalid arguments');
            }
            const rawTransaction = transaction.serialize();
            return this.sendRawTransaction(rawTransaction);
        }
        if (signersOrOptions === undefined || !Array.isArray(signersOrOptions)) {
            throw new Error('Invalid arguments');
        }
        const signers = signersOrOptions;
        if (transaction.nonceInfo) {
            transaction.sign(...signers);
        } else {
            const latestBh = (await this.connection.getLatestBlockhash());
            transaction.recentBlockhash = latestBh.blockhash;
            transaction.sign(...signers);
        }
        const rawTransaction = transaction.serialize();
        return this.sendRawTransaction(rawTransaction);
    }

    /**
     * 
     * @param transaction 
     * @param signersOrOptions 
     * @param _options 
     * @returns 
     */
    async sendAbortableTransaction(transaction: Transaction | VersionedTransaction, signersOrOptions: Array<Signer> | SendOptions, _options?: SendOptions) : Promise<{ signature: TransactionSignature, abortControllers: AbortController[], blockhash?: { blockhash: string, lastValidBlockHeight: number }}> {
        if ('version' in transaction) {
            if (signersOrOptions && Array.isArray(signersOrOptions)) {
              throw new Error('Invalid arguments');
            }
            const rawTransaction = transaction.serialize();
            return this.sendAbortableRawTransaction(rawTransaction);
        }
        if (signersOrOptions === undefined || !Array.isArray(signersOrOptions)) {
            throw new Error('Invalid arguments');
        }
        const signers = signersOrOptions;
        if (transaction.nonceInfo) {
            transaction.sign(...signers);
            const rawTransaction = transaction.serialize();
            const { signature, abortControllers } = await this.sendAbortableRawTransaction(rawTransaction);
            return { signature, abortControllers };
        } else {
            const latestBh = (await this.connection.getLatestBlockhash());
            transaction.recentBlockhash = latestBh.blockhash;
            transaction.sign(...signers);

            const rawTransaction = transaction.serialize();
            const { signature, abortControllers } = await this.sendAbortableRawTransaction(rawTransaction);
            return { signature, abortControllers, blockhash: { ...latestBh } };
        }
        
    }


    /**
     * @param tpu_address
     * @param logger 
     * @param webcrypto 
     * @param rawTransaction 
     * @param abortController 
     * @param retryCount 
     * @param retryMaxCount 
     * @returns 
     */
    async sendSignedRawTransactionToQuicAddress(tpu_address: string, logger: Logger, webcrypto: peculiarWebcrypto.Crypto, rawTransaction: Buffer | number[] | Uint8Array, abortController?: AbortController, retryCount = 0, retryMaxCount = 2) {
        try {
            if (retryCount > 0) {
                console.log('retrying ' + tpu_address);
            }
            const client = await QUICClient.createQUICClient({
                    logger,
                    config: {
                        key: pems.private,
                        cert: pems.cert,
                        verifyPeer: false,
                        applicationProtos: ['solana-tpu'],
                    },
                    serverName: "server",
                    host: tpu_address.split(':')[0],
                    port: parseInt(tpu_address.split(':')[1]),
                    crypto: {
                        ops: {
                            randomBytes: async (data: ArrayBuffer): Promise<void> => {
                                webcrypto.getRandomValues(new Uint8Array(data));
                            },
                        },
                    }
                }
            );
            // solana-quic doesnt support bidirectional streams
            const clientStream = client.connection.newStream('uni');
            // console.log('getting stream writer', index);
            const writer = clientStream.writable.getWriter();
            // console.log('writing to stream', index);
            await writer.write(Uint8Array.from(rawTransaction as Buffer));
            await writer.close();
            if (abortController) {
                abortController.signal.addEventListener('abort', () => {
                    if (writer) {
                        if (!writer.closed) {
                            writer.close();
                        }
                    }
                    if (client) {
                        client.destroy();
                    }
                });
            }
            // console.log('closed', index);
        } catch (error) {
            if (!abortController.signal.aborted) {

                if (error.data.errorCode === 2) {
                    console.error('connection refused', tpu_address);
                } else if (error.data.errorCode === 11) {
                    console.error('invalid token', tpu_address);
                } else if (error.data.errorCode === 1) {
                    console.error('internal error', tpu_address);
                } else {
                    console.error('error', tpu_address);
                    console.error(error);
                    console.error(new TextDecoder().decode(error.data.reason));
                }

                if (retryCount < retryMaxCount) {
                    return await this.sendSignedRawTransactionToQuicAddress(tpu_address, logger, webcrypto, rawTransaction, abortController, retryCount+1, retryMaxCount);
                } else {
                    console.warn('max retry count', tpu_address);
                }
            }
            
        }
    }


    /**
     * 
     * @param rawTransaction 
     * @returns 
     */
    async sendAbortableRawTransaction(rawTransaction: Buffer | number[] | Uint8Array) : Promise<{ signature: TransactionSignature, abortControllers: AbortController[] }> {
        const message = Transaction.from(rawTransaction);
        const signature = base58.encode(Uint8Array.from(message.signature));
        const tpu_addresses = await this.leaderTpuService.leaderTpuSockets(this.fanoutSlots);
        const logger = new Logger(signature, 4);
        const webcrypto = new peculiarWebcrypto.Crypto();
        // console.log('sending abortable ' + `https://solscan.io/tx/${signature}` + ' via QUIC');
        // console.log(tpu_addresses.length, 'addresses');
        
        const abortControllers = tpu_addresses.map((tpu_address) => {
            const abortController = new AbortController();
            this.sendSignedRawTransactionToQuicAddress(tpu_address, logger, webcrypto, rawTransaction, abortController);
            return abortController;
        });

        return { signature, abortControllers };
    }

    //@ts-check
    /**
     * 
     * @param rawTransaction {Buffer | number[] | Uint8ARray}
     * @returns {Promise<string>}
     */
    async sendRawTransaction(rawTransaction: Buffer | number[] | Uint8Array) : Promise<TransactionSignature> {

        const message = Transaction.from(rawTransaction);
        const signature = base58.encode(Uint8Array.from(message.signature));
        const tpu_addresses = await this.leaderTpuService.leaderTpuSockets(this.fanoutSlots);
        const logger = new Logger(signature, 4);
        const webcrypto = new peculiarWebcrypto.Crypto();
        // console.log('sending ' + `https://solscan.io/tx/${signature}` + ' via QUIC');
        // console.log(tpu_addresses.length, 'addresses');
        tpu_addresses.forEach(async (tpu_address) => {
            this.sendSignedRawTransactionToQuicAddress(tpu_address, logger, webcrypto, rawTransaction);
        });
        return signature;
    }
}

export class LeaderTpuService {
    recentSlots: RecentLeaderSlots;
    leaderTpuCache: LeaderTpuCache;
    subscription: number | null;
    connection: Connection;

    //@ts-check
    /**
     * 
     * @param connection {Connection}
     */
    private constructor(connection : Connection) {
        this.connection = connection;
    }

    //@ts-check
    /**
     * 
     * @param connection {Connection}
     * @param websocket_url {string}
     * @returns {Promise<LeaderTpuService>}
     */
    static load(connection : Connection, websocket_url = '') : Promise<LeaderTpuService> {
        return new Promise((resolve) => {
            const leaderTpuService = new LeaderTpuService(connection);
            leaderTpuService.connection.getSlot('processed').then((start_slot) => {
                leaderTpuService.recentSlots = new RecentLeaderSlots(start_slot);
                LeaderTpuCache.load(connection, start_slot).then(leaderTpuCache => {
                    leaderTpuService.leaderTpuCache = leaderTpuCache;
                    if (websocket_url !== '') {
                        leaderTpuService.subscription = connection.onSlotUpdate((slotUpdate) => {
                            if (slotUpdate.type === 'completed') {
                                slotUpdate.slot++;
                            }
                            leaderTpuService.recentSlots.recordSlot(slotUpdate.slot);
                        });
                    } else {
                        leaderTpuService.subscription = null;
                    }
                    leaderTpuService.run();
                    resolve(leaderTpuService);
                });
            });
        });
        
    }

    //@ts-check
    /**
     * 
     * @param fanout_slots {number}
     * @returns {Promise<string[]>}
     */
    leaderTpuSockets(fanout_slots: number) : Promise<string[]> {
        return this.leaderTpuCache.getLeaderSockets(fanout_slots);
    }

    //@ts-check
    /**
     * @returns {void}
     */
    async run() {
        const last_cluster_refresh = Date.now();
        let sleep_ms = 1000;
        setTimeout(async () => {
            sleep_ms = 1000;
            if ( Date.now() - last_cluster_refresh > (1000 * 5 * 60)) {
                try {
                    this.leaderTpuCache.leaderTpuMap = await this.leaderTpuCache.fetchClusterTpuSockets();
                } catch (error) {
                    console.warn('Failed to fetch cluster tpu sockets', error);
                    sleep_ms = 1000;
                }
            }
            const estimatedCurrentSlot = this.recentSlots.estimatedCurrentSlot();
            if (estimatedCurrentSlot >= this.leaderTpuCache.last_epoch_info_slot-this.leaderTpuCache.slots_in_epoch) {
                try {
                    const epochInfo = await this.connection.getEpochInfo('recent');
                    this.leaderTpuCache.slots_in_epoch = epochInfo.slotsInEpoch;
                    this.leaderTpuCache.last_epoch_info_slot = estimatedCurrentSlot;
                } catch (error) {
                    console.warn('failed to get epoch info');
                }
            }
            if (estimatedCurrentSlot >= (this.leaderTpuCache.lastSlot() - MAX_FANOUT_SLOTS)) {
                try {
                    const slot_leaders = await this.leaderTpuCache.fetchSlotLeaders(estimatedCurrentSlot, this.leaderTpuCache.slots_in_epoch);
                    this.leaderTpuCache.first_slot = estimatedCurrentSlot;
                    this.leaderTpuCache.leaders = slot_leaders;
                } catch (error) {
                    console.warn(`Failed to fetch slot leaders (current estimated slot: ${estimatedCurrentSlot})`, error);
                    sleep_ms = 1000;
                }
            }
            this.run();
        }, sleep_ms);
    }
}

export class TpuConnection extends Connection {
    tpuClient: TpuClient;

    //@ts-check
    /**
     * 
     * @param endpoint {string}
     * @param commitmentOrConfig {Commitment | ConnectionConfig}
     */
    private constructor(endpoint : string, commitmentOrConfig?: Commitment | ConnectionConfig) {
        super(endpoint, commitmentOrConfig);
    }

    //@ts-check
    /**
     * 
     * @param transaction {Transaction}
     * @param signers {Array<Signer>}
     * @returns {Promise<string>}
     */
    sendTransaction(transaction: Transaction | VersionedTransaction, signers: Array<Signer> | SendOptions, sendOptions?: SendOptions): Promise<TransactionSignature> {
        return this.tpuClient.sendTransaction(transaction, signers, sendOptions);
    }

    /**
     * 
     * @param transaction 
     * @param signers 
     * @param sendOptions 
     * @returns 
     */
    sendAbortableTransaction(transaction: Transaction | VersionedTransaction, signers: Array<Signer> | SendOptions, sendOptions?: SendOptions): Promise<{ signature: TransactionSignature, abortControllers: AbortController[] }> {
        return this.tpuClient.sendAbortableTransaction(transaction, signers, sendOptions);
    }
    
    /**
     * 
     * @param rawTransaction {Buffer | Array<number> | Uint8Array}
     * @returns {Promise<string>}
     */
    sendRawTransaction(rawTransaction: Buffer | Array<number> | Uint8Array): Promise<TransactionSignature> {
        return this.tpuClient.sendRawTransaction(rawTransaction);
    }

    /**
     * 
     * @param rawTransaction 
     * @returns 
     */
    sendAbortableRawTransaction(rawTransaction: Buffer | Array<number> | Uint8Array) : Promise<{ signature: TransactionSignature, abortControllers: AbortController[] }> {
        return this.tpuClient.sendAbortableRawTransaction(rawTransaction);
    }

    ///@ts-check
    /**
     * 
     * @param connection {TpuConnection}
     * @param transaction {Transaction}
     * @param signers {Array<Signer>}
     * @param options {ConfirmOptions}
     * @returns {Promise<TransactionSignature>}
     */
    async sendAndConfirmTransaction(transaction: Transaction, signers: Array<Signer>, options?: ConfirmOptions) : Promise<TransactionSignature> {
        const signature = await this.sendTransaction(transaction, signers);
        const status = (await this.confirmTransaction(signature, options.commitment)).value;
        if (status.err) {
            throw new Error(`Transaction ${signature} failed (${JSON.stringify(status)})`);
        } else {
            console.log(`Transaction Confirmed https://solana.fm/tx/${signature}`);
        }
        return signature;
    }

    //@ts-check
    /**
     * 
     * @param connection {TpuConnection}
     * @param rawTransaction {Buffer | Array<number> | Uint8Array}
     * @param options {ConfirmOptions}
     * @returns {Promise<string>}
     */
    async sendAndConfirmRawTransaction(rawTransaction: Buffer | Array<number> | Uint8Array, options?: ConfirmOptions) : Promise<TransactionSignature> {
        const signature = await this.sendRawTransaction(rawTransaction);
        const status = (await this.confirmTransaction(signature, options.commitment)).value;
        if (status.err) {
            throw new Error(`Transaction ${signature} failed (${JSON.stringify(status)})`);
        } else {
            console.log(`Transaction Confirmed https://solana.fm/tx/${signature}`);
        }
        return signature;
    }

    /**
     * 
     * @param transaction 
     * @param signers 
     * @param sendOptions 
     * @returns 
     */
    async sendAndConfirmAbortableTransaction(transaction: Transaction | VersionedTransaction, signers: Array<Signer> | SendOptions, sendOptions?: SendOptions) : Promise<TransactionSignature>  {
        const { signature, abortControllers, blockhash } = await this.tpuClient.sendAbortableTransaction(transaction, signers, sendOptions);
        console.log(`sent tx: https://solana.fm/tx/${signature}`);
        try {
            if (!('version' in transaction)) {
                let status: SignatureResult;
                if (blockhash) {
                    try {
                        status = (await this.confirmTransaction({ signature, ...blockhash }, 'processed')).value;
                    } catch (error) {
                        if (error instanceof TransactionExpiredBlockheightExceededError) {
                            return await this.sendAndConfirmAbortableTransaction(transaction, signers, sendOptions);
                        }
                    }
                }  else {
                    status = (await this.confirmTransaction(signature, 'processed')).value;
                }
                if (status.err === null) {
                    console.log(`Transaction Processed https://solana.fm/tx/${signature}`);
                    abortControllers.forEach(controller => controller.abort());
                    return signature;
                } else {
                    console.error(status.err);
                    abortControllers.forEach(controller => controller.abort());
                }
            }
        } catch (error) {
            console.error(error);
        }
        return signature;
    }

    /**
     * 
     * @param rawTransaction 
     * @param blockhash 
     * @returns 
     */
    async sendAndConfirmAbortableRawTransaction(rawTransaction: Buffer | Array<number> | Uint8Array, blockhash?: { blockhash: string, lastValidBlockHeight: number }) : Promise<TransactionSignature>  {
        const { signature, abortControllers } = await this.tpuClient.sendAbortableRawTransaction(rawTransaction);
        let status : SignatureResult;
        if (blockhash) {
            status = (await this.confirmTransaction({ signature, ...blockhash }, 'processed')).value;
        } else {
            status = (await this.confirmTransaction(signature, 'processed')).value;
        }
        if (status.err === null) {
            console.log(`Transaction Processed https://solana.fm/tx/${signature}`);
            abortControllers.forEach(controller => controller.abort());
            return signature;
        } else {
            console.error(status.err);
            abortControllers.forEach(controller => controller.abort());
        }
    }

    //@ts-check
    /**
     * 
     * @param endpoint {string}
     * @param commitmentOrConfig {Commitment | ConnectionConfig}
     * @returns {Promise<TpuConnection>}
     */
    static load(endpoint: string, commitmentOrConfig?: Commitment | ConnectionConfig) : Promise<TpuConnection> {
        
        return new Promise((resolve) => {
            const tpuConnection = new TpuConnection(endpoint, commitmentOrConfig);
            TpuClient.load(tpuConnection).then(tpuClient => {
                tpuConnection.tpuClient = tpuClient;
                resolve(tpuConnection);
            });
        });
    }
}