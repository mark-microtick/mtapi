const bip39 = require(`bip39`)
const bip32 = require(`bip32`)
const bech32 = require(`bech32`)
const secp256k1 = require(`secp256k1`)
const sha256 = require("crypto-js/sha256")
const ripemd160 = require("crypto-js/ripemd160")
const CryptoJS = require("crypto-js")
const axios = require('axios')

const hdPathAtom = `m/44'/118'/0'/0/0`

const standardRandomBytesFunc = x => CryptoJS.lib.WordArray.random(x).toString()

async function generateWalletFromSeed(mnemonic) {
  const masterKey = await deriveMasterKey(mnemonic)
  const { privateKey, publicKey } = deriveKeypair(masterKey)
  const cosmosAddress = createCosmosAddress(publicKey)
  return {
    privateKey: privateKey.toString(`hex`),
    publicKey: publicKey.toString(`hex`),
    cosmosAddress
  }
}

function generateSeed(randomBytesFunc = standardRandomBytesFunc) {
  const randomBytes = Buffer.from(randomBytesFunc(32), `hex`)
  if (randomBytes.length !== 32) throw Error(`Entropy has incorrect length`)
  const mnemonic = bip39.entropyToMnemonic(randomBytes.toString(`hex`))

  return mnemonic
}

async function generateWallet(randomBytesFunc = standardRandomBytesFunc) {
  const mnemonic = generateSeed(randomBytesFunc)
  return await generateWalletFromSeed(mnemonic)
}

// NOTE: this only works with a compressed public key (33 bytes)
function createCosmosAddress(publicKey) {
  const message = CryptoJS.enc.Hex.parse(publicKey.toString(`hex`))
  const hash = ripemd160(sha256(message)).toString()
  const address = Buffer.from(hash, `hex`)
  const cosmosAddress = bech32ify(address, `cosmos`)

  return cosmosAddress
}

async function deriveMasterKey(mnemonic) {
  // throws if mnemonic is invalid
  bip39.validateMnemonic(mnemonic)

  const seed = await bip39.mnemonicToSeed(mnemonic)
  const masterKey = await bip32.fromSeed(seed)
  return masterKey
}

function deriveKeypair(masterKey) {
  const cosmosHD = masterKey.derivePath(hdPathAtom)
  const privateKey = cosmosHD.privateKey
  const publicKey = secp256k1.publicKeyCreate(privateKey, true)

  return {
    privateKey,
    publicKey
  }
}

function bech32ify(address, prefix) {
  const words = bech32.toWords(address)
  return bech32.encode(prefix, words)
}

// Transactions often have amino decoded objects in them {type, value}.
// We need to strip this clutter as we need to sign only the values.
function prepareSignBytes(jsonTx) {
  if (Array.isArray(jsonTx)) {
    return jsonTx.map(prepareSignBytes)
  }

  // string or number
  if (typeof jsonTx !== `object`) {
    return jsonTx
  }
  
  // Check for type / value keys
  if (Object.keys(jsonTx).length === 2 && jsonTx['type'] !== undefined && jsonTx['value'] !== undefined) {
      // remove this layer of hierarchy, process value only
      jsonTx = jsonTx.value
  }
  
  let sorted = {}
  Object.keys(jsonTx)
    .sort()
    .forEach(key => {
      if (jsonTx[key] === undefined || jsonTx[key] === null) return
  
      sorted[key] = prepareSignBytes(jsonTx[key])
    })
  return sorted
}

/*
The SDK expects a certain message format to serialize and then sign.

type StdSignMsg struct {
ChainID       string      `json:"chain_id"`
AccountNumber uint64      `json:"account_number"`
Sequence      uint64      `json:"sequence"`
Fee           auth.StdFee `json:"fee"`
Msgs          []sdk.Msg   `json:"msgs"`
Memo          string      `json:"memo"`
}
*/
function createSignMessage(jsonTx, sequence, account_number, chain_id) {
  // sign bytes need amount to be an array
  const fee = {
    amount: jsonTx.fee.amount || [],
    gas: jsonTx.fee.gas
  }

  return JSON.stringify(
    prepareSignBytes({
      fee,
      memo: jsonTx.memo,
      msgs: jsonTx.msg, // weird msg vs. msgs
      sequence,
      account_number,
      chain_id
    })
  )
}

// produces the signature for a message (returns Buffer)
function signWithPrivateKey(signMessage, privateKey) {
  const signHash = Buffer.from(sha256(signMessage).toString(), `hex`)
  const { signature } = secp256k1.sign(signHash, Buffer.from(privateKey, `hex`))
  return signature
}

function createSignature(signature, publicKey) {
  return {
    signature: signature.toString(`base64`),
    pub_key: {
      type: `tendermint/PubKeySecp256k1`, // TODO: allow other keytypes
      value: publicKey.toString(`base64`)
    }
  }
}

// main function to sign a jsonTx using the local keystore wallet
// returns the complete signature object to add to the tx
function sign(jsonTx, wallet, requestMetaData) {
  const signMessage = createSignMessage(jsonTx, requestMetaData.sequence,
    requestMetaData.account_number, requestMetaData.chain_id)
  const signatureBuffer = signWithPrivateKey(signMessage, wallet.privateKey)
  const pubKeyBuffer = Buffer.from(wallet.publicKey, `hex`)
  return createSignature(
    signatureBuffer,
    pubKeyBuffer
  )
}

// adds the signature object to the tx
function createSignedTx(tx, signature) {
  return Object.assign({}, tx, {
    signatures: [signature]
  })
}

// the broadcast body consists of the signed tx and a return type
function createBroadcastBody(signedTx) {
  return JSON.stringify({
    tx: signedTx,
    return: `block`
  })
}

async function main() {
  const wallet = await generateWallet()
  const url = "microtick/createmarket/" + wallet.cosmosAddress + "/ETHUSD"
  //const url = "microtick/createmarket/cosmos1qlzp94qve0np3du8k43epfc532rxwclxen0pnu/ETHUSD"
  try {
    const res = await axios.get('http://localhost:1317/' + url)
    const msg = res.data
    const signatureBuffer = signWithPrivateKey(msg, wallet.privateKey)
    const pubKeyBuffer = Buffer.from(wallet.publicKey, `hex`)
    const sig = createSignature(
      signatureBuffer,
      pubKeyBuffer
    )
    const signed = createSignedTx(msg, sig)
    console.log(JSON.stringify(signed))
  } catch (err) {
    console.log(err.message)
  }
}

main()


/*
async function main() {
  var msg = {
    type: "auth/StdTx",
    value: {
      msg: [
        {
          type: "microtick/CreateMarket",
          value: {
            Account: wallet.cosmosAddress,
            Market: "LTCUSD",
          }
        }
      ],
      fee: {
        amount: null,
        gas: "200000"
      },
      signatures: null,
      memo: ""
    }
  }
  const signature = sign(msg.value, wallet, {
      sequence: "0", 
      account_number: "9",
      chain_id: "mtzone"
  })
  msg.value = createSignedTx(msg.value, signature)
  console.log(JSON.stringify(msg))
}

main()
*/