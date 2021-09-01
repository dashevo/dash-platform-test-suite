const DashPlatformProtocol = require('@dashevo/dpp');
const getDataContractFixture = require('@dashevo/dpp/lib/test/fixtures/getDataContractFixture');
const generateRandomIdentifier = require('@dashevo/dpp/lib/test/utils/generateRandomIdentifier');

const { verifyProof, executeProof } = require('@dashevo/merk');

const { createFakeInstantLock } = require('dash/build/src/utils/createFakeIntantLock');
const { default: createAssetLockProof } = require('dash/build/src/SDK/Client/Platform/methods/identities/internal/createAssetLockProof');
const { default: createIdentityCreateTransition } = require('dash/build/src/SDK/Client/Platform/methods/identities/internal/createIdentityCreateTransition');
const { default: createIdentityTopUpTransition } = require('dash/build/src/SDK/Client/Platform/methods/identities/internal/createIdnetityTopUpTransition');
const { default: createAssetLockTransaction } = require('dash/build/src/SDK/Client/Platform/createAssetLockTransaction');

const { PrivateKey } = require('@dashevo/dashcore-lib');
const waitForBlocks = require('../../../lib/waitForBlocks');
const waitForBalanceToChange = require('../../../lib/test/waitForBalanceToChange');

const createClientWithFundedWallet = require('../../../lib/test/createClientWithFundedWallet');
const wait = require('../../../lib/wait');

// const parseRootTreeProof = require('../../../lib/parseRootTreeProof');
const testProofStructure = require('../../../lib/test/testProofStructure');
const parseStoreTreeProof = require('../../../lib/parseStoreTreeProof');
const { init: initHashFunction } = require('../../../lib/proofHashFunction');

describe('Platform', () => {
  describe('Identity', () => {
    let dpp;
    let client;
    let identity;
    let walletAccount;
    let walletPublicKey;

    before(async () => {
      dpp = new DashPlatformProtocol();
      await dpp.initialize();

      await initHashFunction();

      client = await createClientWithFundedWallet();
      walletAccount = await client.getWalletAccount();
      ({
        publicKey: walletPublicKey,
      } = walletAccount.identities.getIdentityHDKeyByIndex(0, 0));
    });

    after(async () => {
      if (client) {
        await client.disconnect();
      }
    });

    it('should create an identity', async () => {
      identity = await client.platform.identities.register(3);

      expect(identity).to.exist();

      await waitForBalanceToChange(walletAccount);
    });

    it('should fail to create an identity if instantLock is not valid', async () => {
      const {
        transaction,
        privateKey,
        outputIndex,
      } = await createAssetLockTransaction({
        client,
      }, 1);

      const invalidInstantLock = createFakeInstantLock(transaction.hash);
      const assetLockProof = await dpp.identity.createInstantAssetLockProof(
        invalidInstantLock,
        transaction,
        outputIndex,
      );

      const {
        identityCreateTransition: invalidIdentityCreateTransition,
      } = await createIdentityCreateTransition(
        client.platform, assetLockProof, privateKey,
      );

      let broadcastError;

      try {
        await client.platform.broadcastStateTransition(
          invalidIdentityCreateTransition,
        );
      } catch (e) {
        broadcastError = e;
      }

      expect(broadcastError).to.exist();
      expect(broadcastError.message).to.be.equal('State Transition is invalid: InvalidIdentityAssetLockProofSignatureError: Invalid Asset lock proof signature');
      expect(broadcastError.code).to.be.equal(3);
      const [error] = broadcastError.data.errors;
      expect(error.name).to.equal('InvalidIdentityAssetLockProofSignatureError');
    });

    it('should fail to create an identity with already used asset lock output', async () => {
      const {
        transaction,
        privateKey,
        outputIndex,
      } = await createAssetLockTransaction({ client }, 1);

      await client.getDAPIClient().core.broadcastTransaction(transaction.toBuffer());
      await waitForBlocks(client.getDAPIClient(), 1);

      const assetLockProof = await createAssetLockProof(client.platform, transaction, outputIndex);

      // Creating normal transition
      const {
        identity: identityOne,
        identityCreateTransition: identityCreateTransitionOne,
        identityIndex: identityOneIndex,
      } = await createIdentityCreateTransition(
        client.platform, assetLockProof, privateKey,
      );

      await client.platform.broadcastStateTransition(
        identityCreateTransitionOne,
      );

      walletAccount.storage.insertIdentityIdAtIndex(
        walletAccount.walletId,
        identityOne.getId().toString(),
        identityOneIndex,
      );

      // Creating transition that tries to spend the same transaction
      const {
        identityCreateTransition: identityCreateDoubleSpendTransition,
      } = await createIdentityCreateTransition(
        client.platform, assetLockProof, privateKey,
      );

      let broadcastError;

      try {
        await client.platform.broadcastStateTransition(
          identityCreateDoubleSpendTransition,
        );
      } catch (e) {
        broadcastError = e;
      }

      expect(broadcastError).to.exist();
      expect(broadcastError.message).to.be.equal('State Transition is invalid: IdentityAssetLockTransactionOutPointAlreadyExistsError: Asset lock transaction outPoint already exists');
      expect(broadcastError.code).to.be.equal(3);
      const [error] = broadcastError.data.errors;
      expect(error.name).to.equal('IdentityAssetLockTransactionOutPointAlreadyExistsError');
    });

    it('should fail to create an identity with already used public key', async () => {
      const {
        transaction,
        privateKey,
        outputIndex,
      } = await createAssetLockTransaction({ client }, 1);

      await client.getDAPIClient().core.broadcastTransaction(transaction.toBuffer());
      await waitForBlocks(client.getDAPIClient(), 1);

      const assetLockProof = await createAssetLockProof(client.platform, transaction, outputIndex);

      const duplicateIdentity = dpp.identity.create(
        assetLockProof,
        [walletPublicKey],
      );

      const duplicateIdentityCreateTransition = dpp.identity.createIdentityCreateTransition(
        duplicateIdentity,
      );

      duplicateIdentityCreateTransition.signByPrivateKey(
        privateKey,
      );

      let broadcastError;

      try {
        await client.platform.broadcastStateTransition(
          duplicateIdentityCreateTransition,
        );
      } catch (e) {
        broadcastError = e;
      }

      expect(broadcastError).to.exist();

      expect(broadcastError.message).to.be.equal('Invalid state transition: IdentityPublicKeyAlreadyExistsError: Identity public key already exists');
      expect(broadcastError.code).to.be.equal(2);
      const [error] = broadcastError.data.errors;
      expect(error.name).to.equal('IdentityPublicKeyAlreadyExistsError');
      expect(Buffer.from(error.publicKeyHash)).to.deep.equal(identity.getPublicKeyById(0).hash());
    });

    it('should be able to get newly created identity', async () => {
      const fetchedIdentity = await client.platform.identities.get(
        identity.getId(),
      );

      expect(fetchedIdentity).to.be.not.null();

      const fetchedIdentityWithoutBalance = fetchedIdentity.toJSON();
      delete fetchedIdentityWithoutBalance.balance;

      const localIdentityWithoutBalance = identity.toJSON();
      delete localIdentityWithoutBalance.balance;

      expect(fetchedIdentityWithoutBalance).to.deep.equal(localIdentityWithoutBalance);

      expect(fetchedIdentity.getBalance()).to.be.greaterThan(0);
    });

    it('should be able to get newly created identity by it\'s first public key', async () => {
      const response = await client.getDAPIClient().platform
        .getIdentitiesByPublicKeyHashes(
          [identity.getPublicKeyById(0).hash()],
        );

      const [serializedIdentity] = response.getIdentities();

      expect(serializedIdentity).to.be.not.null();

      const receivedIdentity = dpp.identity.createFromBuffer(
        serializedIdentity,
        { skipValidation: true },
      );

      const receivedIdentityWithoutBalance = receivedIdentity.toJSON();
      delete receivedIdentityWithoutBalance.balance;

      const localIdentityWithoutBalance = identity.toJSON();
      delete localIdentityWithoutBalance.balance;

      expect(receivedIdentityWithoutBalance).to.deep.equal(localIdentityWithoutBalance);
      expect(receivedIdentity.getBalance()).to.be.greaterThan(0);
    });

    it('should be able to get newly created identity id by it\'s first public key', async () => {
      const response = await client.getDAPIClient().platform.getIdentityIdsByPublicKeyHashes(
        [identity.getPublicKeyById(0).hash()],
      );

      const [identityId] = response.getIdentityIds();

      expect(identityId).to.be.not.null();
      expect(identityId).to.deep.equal(identity.getId());
    });

    describe('chainLock', () => {
      let chainLockIdentity;

      it('should create identity using chainLock', async () => {
        console.log('SHOULD CREATE STARTS');
        const {
          transaction,
          privateKey,
          outputIndex,
        } = await createAssetLockTransaction({
          client,
        }, 1);
        console.log('=====');
        console.log({ chainLockIdentity });
        console.log({ transaction });
        console.log({ privateKey });
        console.log({ outputIndex });

        console.log('===>');
        console.log('tx', transaction);
        console.log('txToBuffer', transaction.toBuffer);
        console.log('txToBuffer()', transaction.toBuffer());
        // Broadcast Asset Lock transaction
        await client.getDAPIClient().core.broadcastTransaction(transaction.toBuffer());
        console.log('broadcasted');
        await waitForBlocks(client.getDAPIClient(), 1);

        const { chain } = await client.getDAPIClient().core.getStatus();

        const outPoint = transaction.getOutPointBuffer(outputIndex);
        const assetLockProof = await dpp.identity.createChainAssetLockProof(
          chain.blocksCount,
          outPoint,
        );

        let coreChainLockedHeight = 0;
        while (coreChainLockedHeight < chain.blocksCount) {
          const identityResponse = await client.platform.identities.get(identity.getId());

          const metadata = identityResponse.getMetadata();
          coreChainLockedHeight = metadata.getCoreChainLockedHeight();

          if (coreChainLockedHeight >= chain.blocksCount) {
            break;
          }

          await wait(5000);
        }

        const identityCreateTransitionData = await createIdentityCreateTransition(
          client.platform, assetLockProof, privateKey,
        );
        console.dir({ identityCreateTransitionData }, { depth: null });

        const {
          identityCreateTransition,
        } = identityCreateTransitionData;

        ({ identity: chainLockIdentity } = identityCreateTransitionData);
        console.dir({ chainLockIdentity }, { depth: null });

        await client.platform.broadcastStateTransition(
          identityCreateTransition,
        );

        expect(chainLockIdentity).to.exist();

        await waitForBalanceToChange(walletAccount);
      });

      it('should be able to get newly created identity', async () => {
        const fetchedIdentity = await client.platform.identities.get(
          chainLockIdentity.getId(),
        );

        expect(fetchedIdentity).to.be.not.null();

        const fetchedIdentityWithoutBalance = fetchedIdentity.toJSON();
        delete fetchedIdentityWithoutBalance.balance;

        const localIdentityWithoutBalance = chainLockIdentity.toJSON();
        delete localIdentityWithoutBalance.balance;

        expect(fetchedIdentityWithoutBalance).to.deep.equal(localIdentityWithoutBalance);

        expect(fetchedIdentity.getBalance()).to.be.greaterThan(0);
      });
    });

    describe('Credits', () => {
      let dataContractFixture;

      before(async () => {
        dataContractFixture = getDataContractFixture(identity.getId());

        await client.platform.contracts.broadcast(dataContractFixture, identity);

        client.getApps().set('customContracts', {
          contractId: dataContractFixture.getId(),
          contract: dataContractFixture,
        });
      });

      it('should fail to create more documents if there are no more credits', async () => {
        const document = await client.platform.documents.create(
          'customContracts.niceDocument',
          identity,
          {
            name: 'Some Very Long Long Long Name'.repeat(100),
          },
        );

        let broadcastError;

        try {
          await client.platform.documents.broadcast({
            create: [document],
          }, identity);
        } catch (e) {
          broadcastError = e;
        }

        expect(broadcastError).to.exist();
        expect(broadcastError.message).to.be.equal('Failed precondition: Not enough credits');
        expect(broadcastError.code).to.be.equal(9);
      });

      it.skip('should fail top-up if instant lock is not valid', async () => {
        await waitForBalanceToChange(walletAccount);

        const {
          transaction,
          privateKey,
          outputIndex,
        } = await createAssetLockTransaction({
          client,
        }, 1);

        const instantLock = createFakeInstantLock(transaction.hash);
        const assetLockProof = await dpp.identity.createInstantAssetLockProof(instantLock);

        const identityTopUpTransition = dpp.identity.createIdentityTopUpTransition(
          identity.getId(),
          transaction,
          outputIndex,
          assetLockProof,
        );
        identityTopUpTransition.signByPrivateKey(
          privateKey,
        );

        let broadcastError;

        try {
          await client.platform.broadcastStateTransition(
            identityTopUpTransition,
          );
        } catch (e) {
          broadcastError = e;
        }

        expect(broadcastError).to.exist();
        expect(broadcastError.message).to.be.equal('State Transition is invalid: InvalidIdentityAssetLockProofSignatureError: Invalid Asset lock proof signature');
        expect(broadcastError.code).to.be.equal(3);
        const [error] = broadcastError.data.errors;
        expect(error.name).to.equal('IdentityAssetLockTransactionNotFoundError');
      });

      it('should be able to top-up credit balance', async () => {
        await waitForBalanceToChange(walletAccount);

        const identityBeforeTopUp = await client.platform.identities.get(
          identity.getId(),
        );
        const balanceBeforeTopUp = identityBeforeTopUp.getBalance();
        const topUpAmount = 100;
        const topUpCredits = topUpAmount * 1000;

        await client.platform.identities.topUp(identity.getId(), topUpAmount);

        await waitForBalanceToChange(walletAccount);

        const identityAfterTopUp = await client.platform.identities.get(
          identity.getId(),
        );

        expect(identityAfterTopUp.getBalance()).to.be.greaterThan(balanceBeforeTopUp);
        expect(identityAfterTopUp.getBalance()).to.be.lessThan(balanceBeforeTopUp + topUpCredits);
      });

      it('should be able to create more documents after the top-up', async () => {
        const document = await client.platform.documents.create(
          'customContracts.niceDocument',
          identity,
          {
            name: 'Some Very Long Long Long Name',
          },
        );

        await client.platform.documents.broadcast({
          create: [document],
        }, identity);
      });

      it('should fail to top up an identity with already used asset lock output', async () => {
        const {
          transaction,
          privateKey,
          outputIndex,
        } = await createAssetLockTransaction({ client }, 1);

        await client.getDAPIClient().core.broadcastTransaction(transaction.toBuffer());
        await waitForBlocks(client.getDAPIClient(), 1);

        const assetLockProof = await createAssetLockProof(
          client.platform,
          transaction,
          outputIndex,
        );

        // Creating normal transition
        const identityTopUpTransitionOne = await createIdentityTopUpTransition(
          client.platform, assetLockProof, privateKey, identity.getId(),
        );
        // Creating ST that tries to spend the same output
        const conflictingTopUpStateTransition = await createIdentityTopUpTransition(
          client.platform, assetLockProof, privateKey, identity.getId(),
        );

        await client.platform.broadcastStateTransition(
          identityTopUpTransitionOne,
        );

        let broadcastError;

        try {
          await client.platform.broadcastStateTransition(
            conflictingTopUpStateTransition,
          );
        } catch (e) {
          broadcastError = e;
        }

        expect(broadcastError).to.exist();
        expect(broadcastError.message).to.be.equal('State Transition is invalid: IdentityAssetLockTransactionOutPointAlreadyExistsError: Asset lock transaction outPoint already exists');
        expect(broadcastError.code).to.be.equal(3);
        const [error] = broadcastError.data.errors;
        expect(error.name).to.equal('IdentityAssetLockTransactionOutPointAlreadyExistsError');
      });
    });

    describe('Proofs', () => {
      let identityAtKey5;
      let identityAtKey6;
      let identityAtKey8;
      let nonIncludedIdentityPubKeyHash;
      let identity6PublicKeyHash;
      let identity8PublicKeyHash;

      before(async () => {
        identityAtKey5 = await client.platform.identities.register(5);
        identityAtKey6 = await client.platform.identities.register(6);
        identityAtKey8 = await client.platform.identities.register(8);

        await waitForBalanceToChange(walletAccount);

        nonIncludedIdentityPubKeyHash = new PrivateKey().toPublicKey().hash;

        // Public key hashes
        identity6PublicKeyHash = identityAtKey6.getPublicKeyById(0).hash();
        identity8PublicKeyHash = identityAtKey8.getPublicKeyById(0).hash();
      });

      it('should be able to get and verify proof that identity exists with getIdentity', async () => {
        identity = identityAtKey5;

        const identityProof = await client.getDAPIClient().platform.getIdentity(
          identity.getId(), { prove: true },
        );

        const fullProof = identityProof.proof;

        testProofStructure(expect, fullProof);

        const identitiesProofBuffer = fullProof.storeTreeProofs.getIdentitiesProof();

        const parsedStoreTreeProof = parseStoreTreeProof(identitiesProofBuffer);

        const parsedIdentity = client.platform.dpp
          .identity.createFromBuffer(parsedStoreTreeProof.values[0]);
        expect(identity.getId()).to.be.deep.equal(parsedIdentity.getId());

        const { rootHash: identityLeafRoot } = executeProof(identitiesProofBuffer);

        const verificationResult = verifyProof(
          identitiesProofBuffer,
          [identity.getId()],
          identityLeafRoot,
        );

        // We pass one key
        expect(verificationResult.length).to.be.equal(1);
        // Identity with id at index 0 doesn't exist
        const recoveredIdentityBuffer = verificationResult[0];
        expect(recoveredIdentityBuffer).to.be.an.instanceof(Uint8Array);

        const recoveredIdentity = client.platform.dpp
          .identity.createFromBuffer(recoveredIdentityBuffer);

        // Deep equal won't work in this case, because identity returned by the register
        const actualIdentity = identity.toJSON();
        // Because the actual identity state is before the registration, and the
        // balance wasn't added to it yet
        actualIdentity.balance = recoveredIdentity.toJSON().balance;
        expect(recoveredIdentity.toJSON()).to.be.deep.equal(actualIdentity);
      });

      it('should be able to verify proof that identity does not exist', async () => {
        // The same as above, but for an identity id that doesn't exist
        const fakeIdentityId = generateRandomIdentifier();

        const identityProof = await client.getDAPIClient().platform.getIdentity(
          fakeIdentityId, { prove: true },
        );

        const fullProof = identityProof.proof;

        testProofStructure(expect, fullProof);

        const identitiesProofBuffer = fullProof.storeTreeProofs.getIdentitiesProof();

        // const rootTreeProof = parseRootTreeProof(fullProof.rootTreeProof);
        const parsedStoreTreeProof = parseStoreTreeProof(identitiesProofBuffer);

        const identitiesFromProof = parsedStoreTreeProof.values;

        const valueIds = identitiesFromProof.map((identityValue) => client.platform.dpp
          .identity.createFromBuffer(identityValue).getId().toString('hex'));

        // The proof will contain left and right values to the empty place
        expect(valueIds.indexOf(fakeIdentityId.toString('hex'))).to.be.equal(-1);

        const { rootHash: identityLeafRoot } = executeProof(identitiesProofBuffer);

        const identityIdsToProve = [fakeIdentityId];

        const verificationResult = verifyProof(
          identitiesProofBuffer,
          identityIdsToProve,
          identityLeafRoot,
        );

        // We pass one key
        expect(verificationResult.length).to.be.equal(1);
        // Identity with id at index 0 doesn't exist
        expect(verificationResult[0]).to.be.null();
      });

      it('should be able to verify that multiple identities exist with getIdentitiesByPublicKeyHashes', async () => {
        const publicKeyHashes = [
          identity6PublicKeyHash,
          nonIncludedIdentityPubKeyHash,
          identity8PublicKeyHash,
        ];

        /* Requesting identities by public key hashes and verifying the structure */

        const identityProof = await client.getDAPIClient().platform.getIdentitiesByPublicKeyHashes(
          publicKeyHashes, { prove: true },
        );

        const fullProof = identityProof.proof;

        testProofStructure(expect, fullProof);

        const identitiesProofBuffer = fullProof.storeTreeProofs.getIdentitiesProof();
        const publicKeyHashesProofBuffer = fullProof.storeTreeProofs
          .getPublicKeyHashesToIdentityIdsProof();

        /* Parsing values from the proof */

        const parsedIdentitiesStoreTreeProof = parseStoreTreeProof(identitiesProofBuffer);

        // Existing identities should be in the identitiesProof, as it also serves
        // as an inclusion proof
        const restoredIdentities = parsedIdentitiesStoreTreeProof.values.map(
          (identityBuffer) => client.platform.dpp.identity.createFromBuffer(identityBuffer),
        );

        /* Figuring out what was found */

        const foundIdentityIds = [];
        const notFoundPublicKeyHashes = [];

        // Scanning through public keys to figure out what identities were found
        for (const publicKeyHash of publicKeyHashes) {
          const foundIdentity = restoredIdentities
            .find(
              (restoredIdentity) => restoredIdentity.getPublicKeyById(0)
                .hash().toString('hex') === publicKeyHash.toString('hex'),
            );
          if (foundIdentity) {
            foundIdentityIds.push(foundIdentity.getId());
          } else {
            notFoundPublicKeyHashes.push(publicKeyHash);
          }
        }

        // We expect to find 2 identities out of 3 keys
        expect(foundIdentityIds.length).to.be.equal(2);
        expect(notFoundPublicKeyHashes.length).to.be.equal(1);

        // Note that identities in the proof won't necessary preserve the order in which they
        // were requested. This happens due to the proof structure: sorting values in the
        // proof would result in a different root hash.
        expect(foundIdentityIds.findIndex(
          (identityId) => identityId.toString('hex') === identityAtKey6.getId().toString('hex'),
        )).to.be.greaterThan(-1);
        expect(foundIdentityIds.findIndex(
          (identityId) => identityId.toString('hex') === identityAtKey8.getId().toString('hex'),
        )).to.be.greaterThan(-1);

        expect(notFoundPublicKeyHashes[0]).to.be.deep.equal(nonIncludedIdentityPubKeyHash);

        // Non-existing public key hash should be included into the identityIdsProof,
        // as it serves as a non-inclusion proof for the public keys

        /* Extracting root */

        // While extracting the root isn't specifically useful for this test,
        // it is needed to fit those roots into the root tree later.
        const { rootHash: identityLeafRoot } = executeProof(identitiesProofBuffer);
        const { rootHash: identityIdsLeafRoot } = executeProof(publicKeyHashesProofBuffer);

        /* Inclusion proof */

        // Note that you first has to parse values from the
        // proof and find identity ids you were looking for
        const inclusionVerificationResult = verifyProof(
          identitiesProofBuffer,
          foundIdentityIds,
          identityLeafRoot,
        );

        expect(inclusionVerificationResult.length).to.be.equal(2);

        const firstRecoveredIdentityBuffer = inclusionVerificationResult[0];
        const secondRecoveredIdentityBuffer = inclusionVerificationResult[1];
        expect(firstRecoveredIdentityBuffer).to.be.an.instanceof(Uint8Array);
        expect(secondRecoveredIdentityBuffer).to.be.an.instanceof(Uint8Array);

        const firstRecoveredIdentity = client.platform.dpp
          .identity.createFromBuffer(firstRecoveredIdentityBuffer);

        const secondRecoveredIdentity = client.platform.dpp
          .identity.createFromBuffer(secondRecoveredIdentityBuffer);

        // Deep equal won't work in this case, because identity returned by the register
        const actualIdentityAtKey6 = identityAtKey6.toJSON();
        const actualIdentityAtKey8 = identityAtKey8.toJSON();
        // Because the actual identity state is before the registration, and the
        // balance wasn't added to it yet
        actualIdentityAtKey6.balance = firstRecoveredIdentity.toJSON().balance;
        actualIdentityAtKey8.balance = secondRecoveredIdentity.toJSON().balance;

        expect(firstRecoveredIdentity.toJSON()).to.be.deep.equal(actualIdentityAtKey6);
        expect(secondRecoveredIdentity.toJSON()).to.be.deep.equal(actualIdentityAtKey8);

        /* Non-inclusion proof */

        const nonInclusionVerificationResult = verifyProof(
          publicKeyHashesProofBuffer,
          notFoundPublicKeyHashes,
          identityIdsLeafRoot,
        );

        expect(nonInclusionVerificationResult.length).to.be.equal(1);

        const nonIncludedIdentityId = nonInclusionVerificationResult[0];
        expect(nonIncludedIdentityId).to.be.null();
      });

      it('should be able to verify identityIds with getIdentityIdsByPublicKeyHashes', async () => {
        const publicKeyHashes = [
          identity6PublicKeyHash,
          nonIncludedIdentityPubKeyHash,
          identity8PublicKeyHash,
        ];

        /* Requesting identities by public key hashes and verifying the structure */

        const identityProof = await client.getDAPIClient().platform.getIdentityIdsByPublicKeyHashes(
          publicKeyHashes, { prove: true },
        );

        const fullProof = identityProof.proof;

        testProofStructure(expect, fullProof);

        const publicKeyHashesProofBuffer = fullProof.storeTreeProofs
          .getPublicKeyHashesToIdentityIdsProof();

        /* Extracting root */

        const {
          rootHash: publicKeyHashesToIdentityIdsLeafRoot,
        } = executeProof(publicKeyHashesProofBuffer);

        /* Verifying proof */

        // Note that you first has to parse values from the
        // proof and find identity ids you were looking for
        const verificationResult = verifyProof(
          publicKeyHashesProofBuffer,
          publicKeyHashes,
          publicKeyHashesToIdentityIdsLeafRoot,
        );

        expect(verificationResult.length).to.be.equal(3);

        const firstIdentityId = verificationResult[0];
        const secondIdentityId = verificationResult[1];
        const thirdIdentityId = verificationResult[2];

        expect(firstIdentityId).to.be.an.instanceof(Uint8Array);
        // In the verifyProof call, non existing key is passed as a second element
        // and verifyProof returns values sorted in the same way as they were
        // passed to the function
        expect(secondIdentityId).to.be.null();
        expect(thirdIdentityId).to.be.an.instanceof(Uint8Array);

        expect(firstIdentityId).to.be.deep.equal(identityAtKey6.getId());
        expect(thirdIdentityId).to.be.deep.equal(identityAtKey8.getId());
      });
    });
  });
});
