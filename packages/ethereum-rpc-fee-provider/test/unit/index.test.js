/* eslint-env mocha */

import chai, { expect } from 'chai'

import Client from '../../../client/lib'
import EthereumRpcProvider from '../../../ethereum-rpc-provider/lib'
import EthereumRpcFeeProvider from '../../lib'

const mockJsonRpc = require('../../../../test/mock/mockJsonRpc')
const ethereumRpc = require('../../../../test/mock/ethereum/rpc')

chai.use(require('chai-bignumber')())
chai.config.truncateThreshold = 0

describe('Ethereum RPC Fee provider', () => {
  let client

  beforeEach(() => {
    client = new Client()
    client.addProvider(new EthereumRpcProvider('http://localhost:8545'))
    client.addProvider(new EthereumRpcFeeProvider(1, 1.5, 2))

    mockJsonRpc('http://localhost:8545', ethereumRpc, 100)
  })

  describe('getFees', () => {
    it('Should return correct fees', async () => {
      const fees = await client.chain.getFees()
      expect(fees.slow.fee).to.equal(10)
      expect(fees.average.fee).to.equal(15)
      expect(fees.fast.fee).to.equal(20)
    })
  })
})
