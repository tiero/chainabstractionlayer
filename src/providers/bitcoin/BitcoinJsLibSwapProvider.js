import Provider from '../../Provider'
import { addressToPubKeyHash, pubKeyToAddress, reverseBuffer, scriptNumEncode } from './BitcoinUtil'
import { sha256, padHexStart } from '../../crypto'
import networks from './networks'
import bitcoin from 'bitcoinjs-lib'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export default class BitcoinJsLibSwapProvider extends Provider {
  // TODO: have a generate InitSwap and generate RecipSwap
  //   InitSwap should use checkSequenceVerify instead of checkLockTimeVerify

  constructor (chain = { network: networks.bitcoin }) {
    super()
    this._network = chain.network
    this._bitcoinJsNetwork = this._network.isTestnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin
  }

  createSwapScript (recipientAddress, refundAddress, secretHash, expiration) {
    let expirationHex = scriptNumEncode(expiration)

    const recipientPubKeyHash = addressToPubKeyHash(recipientAddress)
    const refundPubKeyHash = addressToPubKeyHash(refundAddress)
    const expirationPushDataOpcode = padHexStart(expirationHex.length.toString(16))
    const expirationHexEncoded = expirationHex.toString('hex')

    return [
      '63', // OP_IF
      'a8', // OP_SHA256
      '20', secretHash, // OP_PUSHDATA(20) {secretHash}
      '88', // OP_EQUALVERIFY
      '76', // OP_DUP
      'a9', // OP_HASH160
      '14', recipientPubKeyHash, // OP_PUSHDATA(20) {recipientPubKeyHash}
      '67', // OP_ELSE
      expirationPushDataOpcode, // OP_PUSHDATA({expirationHexLength})
      expirationHexEncoded, // {expirationHexEncoded}
      'b1', // OP_CHECKLOCKTIMEVERIFY
      '75', // OP_DROP
      '76', // OP_DUP
      'a9', // OP_HASH160
      '14', refundPubKeyHash, // OP_PUSHDATA(20) {refundPubKeyHash}
      '68', // OP_ENDIF
      '88', 'ac' // OP_EQUALVERIFY OP_CHECKSIG
    ].join('')
  }

  async initiateSwap (value, recipientAddress, refundAddress, secretHash, expiration) {
    const script = this.createSwapScript(recipientAddress, refundAddress, secretHash, expiration)
    const scriptPubKey = padHexStart(script)
    const p2shAddress = pubKeyToAddress(scriptPubKey, this._network.name, 'scriptHash')
    return this.getMethod('sendTransaction')(p2shAddress, value, script)
  }

  async claimSwap (initiationTxHash, recipientAddress, refundAddress, secret, expiration) {
    const wif = await this.getMethod('dumpPrivKey')(recipientAddress)
    const wallet = bitcoin.ECPair.fromWIF(wif, this._bitcoinJsNetwork)
    const secretHash = sha256(secret)
    const script = this.createSwapScript(recipientAddress, refundAddress, secretHash, expiration)
    const scriptPubKey = padHexStart(script)
    const p2shAddress = pubKeyToAddress(scriptPubKey, this._network.name, 'scriptHash')
    const sendScript = this.getMethod('createScript')(p2shAddress)

    const initiationTxRaw = await this.getMethod('getRawTransactionByHash')(initiationTxHash)
    const initiationTx = await this.getMethod('decodeRawTransaction')(initiationTxRaw)
    const voutIndex = initiationTx._raw.data.vout.findIndex((vout) => vout.scriptPubKey.hex === sendScript)
    let vout = initiationTx._raw.data.vout[voutIndex]
    const txfee = await this.getMethod('calculateFee')(1, 1, 3)

    secret = Buffer.from(secret, 'hex')
    vout.txid = initiationTxHash
    vout.vSat = vout.value * 1e8
    vout.script = Buffer.from(script, 'hex')
    const walletRedeem = this.spendSwap(recipientAddress, wallet, secret, true, txfee, vout, this._bitcoinJsNetwork, expiration)
    return this.getMethod('sendRawTransaction')(walletRedeem)
  }

  spendSwap (address, wallet, secret, isRedeem, txfee, vout, network, expiration) {
    network = network || bitcoin.networks.bitcoin
    const hashType = bitcoin.Transaction.SIGHASH_ALL

    const txb = new bitcoin.TransactionBuilder(network)

    if (!isRedeem) txb.setLockTime(expiration)

    txb.addInput(vout.txid, vout.n, 0)
    txb.addOutput(address, vout.vSat - txfee)

    const txRaw = txb.buildIncomplete()
    const sigHash = txRaw.hashForSignature(0, vout.script, hashType)

    const redeemScriptSig = bitcoin.script.swap.input.encode(
      wallet.sign(sigHash).toScriptSignature(hashType),
      wallet.getPublicKeyBuffer(),
      isRedeem,
      secret
    )

    const redeem = bitcoin.script.scriptHash.input.encode(
      redeemScriptSig, vout.script)

    txRaw.setInputScript(0, redeem)
    return txRaw.toHex()
  }

  async refundSwap (initiationTxHash, recipientAddress, refundAddress, secretHash, expiration) {
    throw new Error('BitcoinJsLibSwapProvider: Refunding not implemented')
  }

  _spendSwap (signature, pubKey, isClaim, secret) {
    const redeemEncoded = isClaim ? '51' : '00' // OP_1 : OP_0
    const encodedSecret = isClaim
      ? [
        padHexStart((secret.length / 2).toString(16)), // OP_PUSHDATA({secretLength})
        secret
      ]
      : ['00'] // OP_0

    const signatureEncoded = signature + '01'
    const signaturePushDataOpcode = padHexStart((signatureEncoded.length / 2).toString(16))
    const pubKeyPushDataOpcode = padHexStart((pubKey.length / 2).toString(16))

    const bytecode = [
      signaturePushDataOpcode,
      signatureEncoded,
      ...encodedSecret,
      redeemEncoded,
      pubKeyPushDataOpcode,
      pubKey
    ]

    return bytecode.join('')
  }

  _spendSwapInput (spendSwapBytecode, voutScript) {
    const bytecode = [
      spendSwapBytecode,
      '4c',
      padHexStart((voutScript.length / 2).toString(16)),
      voutScript
    ]

    return bytecode.join('')
  }

  getRedeemSwapData (secret, pubKey, signature) {
    return this._spendSwap(signature, pubKey, true, secret)
  }

  getRefundSwapData (pubKey, signature) {
    return this._spendSwap(signature, pubKey, false)
  }

  doesTransactionMatchSwapParams (transaction, value, recipientAddress, refundAddress, secretHash, expiration) {
    const data = this.createSwapScript(recipientAddress, refundAddress, secretHash, expiration)
    const scriptPubKey = padHexStart(data)
    const receivingAddress = pubKeyToAddress(scriptPubKey, this._network.name, 'scriptHash')
    const sendScript = this.getMethod('createScript')(receivingAddress)
    return Boolean(transaction._raw.vout.find(vout => vout.scriptPubKey.hex === sendScript && vout.valueSat === value))
  }

  async verifyInitiateSwapTransaction (initiationTxHash, value, recipientAddress, refundAddress, secretHash, expiration) {
    const initiationTransaction = await this.getMethod('getTransactionByHash')(initiationTxHash)
    return this.doesTransactionMatchSwapParams(initiationTransaction, value, recipientAddress, refundAddress, secretHash, expiration)
  }

  async findInitiateSwapTransaction (value, recipientAddress, refundAddress, secretHash, expiration) {
    let blockNumber = await this.getMethod('getBlockHeight')()
    let initiateSwapTransaction = null
    while (!initiateSwapTransaction) {
      let block
      try {
        block = await this.getMethod('getBlockByNumber')(blockNumber, true)
      } catch (e) { }
      if (block) {
        initiateSwapTransaction = block.transactions.find(tx => this.doesTransactionMatchSwapParams(tx, value, recipientAddress, refundAddress, secretHash, expiration))
        blockNumber++
      }
      await sleep(5000)
    }
    return initiateSwapTransaction
  }

  async findClaimSwapTransaction (initiationTxHash, secretHash) {
    let blockNumber = await this.getMethod('getBlockHeight')()
    let claimSwapTransaction = null
    while (!claimSwapTransaction) {
      let block
      try {
        block = await this.getMethod('getBlockByNumber')(blockNumber, true)
      } catch (e) { }
      if (block) {
        claimSwapTransaction = block.transactions.find(tx =>
          tx._raw.vin.find(vin => vin.txid === initiationTxHash)
        )
        blockNumber++
      }
      await sleep(5000)
    }

    return {
      ...claimSwapTransaction,
      secret: await this.getSwapSecret(claimSwapTransaction.hash)
    }
  }

  async getSwapSecret (claimTxHash) {
    const claimTxRaw = await this.getMethod('getRawTransactionByHash')(claimTxHash)
    const claimTx = await this.getMethod('decodeRawTransaction')(claimTxRaw)
    const script = Buffer.from(claimTx._raw.data.vin[0].scriptSig.hex, 'hex')
    const sigLength = script[0]
    const secretLength = script.slice(sigLength + 1)[0]
    return script.slice(sigLength + 2, sigLength + secretLength + 2).toString('hex')
  }

  generateSigTxInput (txHashLE, voutIndex, script) {
    const inputTxOutput = padHexStart(voutIndex.toString(16), 8)
    const scriptLength = padHexStart((script.length / 2).toString(16))

    return [
      '01', // NUM INPUTS
      txHashLE,
      inputTxOutput, // INPUT TRANSACTION OUTPUT
      scriptLength,
      script,
      '00000000' // SEQUENCE
    ].join('')
  }

  generateRawTxInput (txHashLE, script) {
    const scriptLength = padHexStart((script.length / 2).toString(16))

    return [
      '01', // NUM INPUTS
      txHashLE,
      '00000000',
      scriptLength,
      script,
      '00000000' // SEQUENCE
    ].join('')
  }

  generateRawTx (initiationTx, voutIndex, address, input, locktime) {
    const output = initiationTx.outputs[voutIndex]
    const value = parseInt(reverseBuffer(output.amount).toString('hex'), 16)
    const fee = this.getMethod('calculateFee')(1, 1, 3)
    const amount = value - fee
    const amountLE = Buffer.from(padHexStart(amount.toString(16), 16), 'hex').reverse().toString('hex') // amount in little endian
    const pubKeyHash = addressToPubKeyHash(address)

    return [
      '01000000', // VERSION

      input,

      '01', // NUM OUTPUTS
      amountLE,
      '19', // data size to be pushed
      '76', // OP_DUP
      'a9', // OP_HASH160
      '14', // data size to be pushed
      pubKeyHash, // <PUB_KEY_HASH>
      '88', // OP_EQUALVERIFY
      'ac', // OP_CHECKSIG

      locktime // LOCKTIME
    ].join('')
  }
}
