const GrpcErrorCodes = require('@dashevo/grpc-common/lib/server/error/GrpcErrorCodes');

const getDataContractFixture = require(
  '@dashevo/dpp/lib/test/fixtures/getDataContractFixture',
);

const getClientWithFundedWallet = require('../../../lib/test/getClientWithFundedWallet');

describe('Platform', function platform() {
  this.timeout(950000);

  let client;
  let dpp;
  let identityPrivateKey;
  let dataContractFixture;
  let publicKeyId;
  let identity;

  before(async () => {
    client = await getClientWithFundedWallet();

    identity = await client.platform.identities.register();
  });

  after(async () => {
    if (client) {
      await client.disconnect();
    }
  });

  describe('Data contract', () => {
    it('should fail to create new data contract with unknown owner', async () => {
      dataContractFixture = getDataContractFixture();

      const dataContractCreateTransition = dpp.dataContract.createStateTransition(
        dataContractFixture,
      );
      dataContractCreateTransition.sign(identity.getPublicKeyById(publicKeyId), identityPrivateKey);

      try {
        // Create Data Contract
        await client.clients.dapi.platform.broadcastStateTransition(
          dataContractCreateTransition.serialize(),
        );

        expect.fail(' should throw invalid argument error');
      } catch (e) {
        expect(e.code).to.equal(GrpcErrorCodes.INVALID_ARGUMENT);
        expect(e.details).to.equal('State Transition is invalid');
      }
    });

    it('should create new data contract with previously created identity as an owner', async () => {
      dataContractFixture = getDataContractFixture(identity.getId());

      // Create Data Contract
      const dataContract = await client.platform.contracts.create(
        dataContractFixture.getDefinitions(), identity,
      );

      await client.platform.contracts.broadcast(dataContract, identity);
    });

    it('should be able to get newly created data contract', async () => {
      const serializedDataContract = await client.platform.contracts.get(
        dataContractFixture.getId(),
      );

      expect(serializedDataContract).to.be.not.null();

      const receivedDataContract = await dpp.dataContract.createFromSerialized(
        serializedDataContract,
        { skipValidation: true },
      );

      expect(dataContractFixture.toJSON()).to.deep.equal(receivedDataContract.toJSON());
    });
  });
});
