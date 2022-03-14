const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const Utxo = require('../src/utxo')
const { transaction, registerAndTransact, prepareTransaction, buildMerkleTree } = require('../src/index')
const { toFixedHex, poseidonHash } = require('../src/utils')
const { Keypair } = require('../src/keypair')
const { encodeDataForBridge } = require('./utils')

const MERKLE_TREE_HEIGHT = 5
const l1ChainId = 1
const MINIMUM_WITHDRAWAL_AMOUNT = utils.parseEther(process.env.MINIMUM_WITHDRAWAL_AMOUNT || '0.05')
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther(process.env.MAXIMUM_DEPOSIT_AMOUNT || '1')

describe('TornadoPool', function () {
  this.timeout(20000)

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, gov, l1Unwrapper, multisig] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const verifier16 = await deploy('Verifier16')
    const hasher = await deploy('Hasher')

    const token = await deploy('PermittableToken', 'Wrapped ETH', 'WETH', 18, l1ChainId)
    await token.mint(sender.address, utils.parseEther('10000'))

    const amb = await deploy('MockAMB', gov.address, l1ChainId)
    const omniBridge = await deploy('MockOmniBridge', amb.address)

    /** @type {TornadoPool} */
    const tornadoPoolImpl = await deploy(
      'TornadoPool',
      verifier2.address,
      verifier16.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
      token.address,
      omniBridge.address,
      l1Unwrapper.address,
      gov.address,
      l1ChainId,
      multisig.address,
    )

    const { data } = await tornadoPoolImpl.populateTransaction.initialize(
      MINIMUM_WITHDRAWAL_AMOUNT,
      MAXIMUM_DEPOSIT_AMOUNT,
    )
    const proxy = await deploy(
      'CrossChainUpgradeableProxy',
      tornadoPoolImpl.address,
      gov.address,
      data,
      amb.address,
      l1ChainId,
    )

    const tornadoPool = tornadoPoolImpl.attach(proxy.address)

    await token.approve(tornadoPool.address, utils.parseEther('10000'))

    const merkleTreeWithHistory = await deploy(
        'MerkleTreeWithHistoryMock',
        MERKLE_TREE_HEIGHT,
        hasher.address,
      )
    await merkleTreeWithHistory.initialize()

    return { tornadoPool, token, proxy, omniBridge, amb, gov, multisig, merkleTreeWithHistory, hasher }
  }

  it("Q3.2", async () => {
    // Q3.2.1
    const { merkleTreeWithHistory } = await loadFixture(fixture)
    var gas = await merkleTreeWithHistory.estimateGas.insert(toFixedHex(123), toFixedHex(456))
    console.log('gas needed to insert a pair of leaves: ', gas.toString())

    // Q3.2.2
    const { tornadoPool, token, omniBridge } = await loadFixture(fixture)
    const depositorKeypair = new Keypair()

    const depositorDepositAmount = utils.parseEther('0.08')
    const depositorDepositUtxo = new Utxo({ amount: depositorDepositAmount, keypair: depositorKeypair })
    const { args, extData } = await prepareTransaction({
      tornadoPool,
      outputs: [depositorDepositUtxo],
    })

    const onTokenBridgedData = encodeDataForBridge({
      proof: args,
      extData,
    })

    const onTokenBridgedTx = await tornadoPool.populateTransaction.onTokenBridged(
      token.address,
      depositorDepositUtxo.amount,
      onTokenBridgedData,
    )
    
    await token.transfer(omniBridge.address, depositorDepositAmount)
    const transferTx = await token.populateTransaction.transfer(tornadoPool.address, depositorDepositAmount)

    await omniBridge.execute([
      { who: token.address, callData: transferTx.data }, 
      { who: tornadoPool.address, callData: onTokenBridgedTx.data }, 
    ])

    // Q3.2.3
    const depositorWithdrawAmount = utils.parseEther('0.05')
    const recipient = '0x13b75E274Acb0eb9cEd75FcF7eA9AA28E5C7aa42'
    const depositorChangeUtxo = new Utxo({
      amount: depositorDepositAmount.sub(depositorWithdrawAmount),
      keypair: depositorKeypair,
    })

    await transaction({
      tornadoPool,
      inputs: [depositorDepositUtxo],
      outputs: [depositorChangeUtxo],
      recipient: recipient,
      isL1Withdrawal: true,
    })

    //Q3.2.4
    const recipientBalance = await token.balanceOf(recipient)
    expect(recipientBalance).to.be.equal(0)
    const omniBridgeBalance = await token.balanceOf(omniBridge.address)
    expect(omniBridgeBalance).to.be.equal(utils.parseEther('0.05'))
    const tornadoPoolBalance = await token.balanceOf(tornadoPool.address)
    expect(tornadoPoolBalance).to.be.equal(utils.parseEther('0.03'))
  })
})