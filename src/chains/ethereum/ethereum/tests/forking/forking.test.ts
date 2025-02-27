import http from "http";
import ganache from "../../../../../packages/core";
import assert from "assert";
import EthereumProvider from "../../src/provider";
import Server from "../../../../../packages/core/lib/src/server";
import { Quantity, WEI } from "@ganache/utils";
import {
  logging,
  startLocalChain,
  updateRemotesAccountsBalances,
  updateRemotesAccountNonces,
  range
} from "./helpers";
import compile from "../helpers/compile";
import path from "path";
import { CodedError } from "@ganache/ethereum-utils";

describe("forking", () => {
  const PORT = 9999;
  const NETWORK_ID = 1234;
  const REMOTE_ACCOUNT_COUNT = 15;
  let remoteServer: Server;
  let remoteProvider: EthereumProvider;
  let remoteAccounts: string[];

  beforeEach("start remote chain", async () => {
    remoteServer = ganache.server({
      logging,
      wallet: { deterministic: true, totalAccounts: REMOTE_ACCOUNT_COUNT },
      chain: { networkId: NETWORK_ID }
    });
    remoteProvider = (remoteServer.provider as unknown) as EthereumProvider;
    remoteAccounts = Object.keys(remoteProvider.getInitialAccounts());
    await remoteServer.listen(PORT);
  });

  afterEach(async () => {
    try {
      remoteServer && remoteServer.status === 4 && (await remoteServer.close());
    } catch (e) {
      console.log(e);
    }
  });
  describe("invalid/exceptional responses", async () => {
    // contents of FAKE_BLOCK don't matter, it just needs to be parsable
    // by ganache
    const FAKE_BLOCK = {
      baseFeePerGas: "0x0",
      difficulty: "0x0",
      extraData: "0x0",
      gasLimit: "0x0",
      gasUsed: "0x0",
      hash:
        "0x925238ca364205c502b1771d80cd569e4200000b9aca6ded77fc8fe8f7b9e055",
      logsBloom: "0x0",
      miner: "0x0",
      mixHash:
        "0x393fc96d0a8261f7c2c75aef0eb2200a1e6c024ee59284ea1b5426132b30c406",
      nonce: "0x0",
      number: "0x1",
      parentHash:
        "0xf8c6cf0ee02ea9001964a3d9b47054eff5b0c3364614ee5422984aa69e4e0eee",
      receiptsRoot:
        "0xf4f972acf830ea9efb8afbb0973fb601d39e723277839b341727cd0b855b43a6",
      sha3Uncles:
        "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
      size: "0x0",
      stateRoot:
        "0x3627cfcfeeb0ef7085c79c2e4bdc9906a97b1edaae770147b0a3e4d10f497400",
      timestamp: "0x0",
      totalDifficulty: "0x0",
      transactions: []
    };
    const port = 9988;
    let junk: any;
    let server: http.Server;
    beforeEach("start mock http server", async () => {
      // mock a server so we can send bad requests back at ganache
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", data => {
          body += data;
        });
        req.on("end", function () {
          const json = JSON.parse(body);
          res.writeHead(200, { "content-type": "application/json" });
          if (json.method === "eth_getBalance") {
            // for any eth_getBalance call return the `junk` data
            res.end(JSON.stringify(junk));
          } else if (json.method === "eth_getBlockByNumber") {
            res.end(
              JSON.stringify({
                id: json.id,
                jsonrpc: "2.0",
                result: FAKE_BLOCK
              })
            );
          } else {
            // reply with a 0x1 for all the initialization requests just so
            // things start up
            res.end(
              JSON.stringify({ id: json.id, jsonrpc: "2.0", result: "0x1" })
            );
          }
        });
      });
      await new Promise<void>(resolve => server.listen(port, resolve));
    });
    afterEach("stop mock http server", done => {
      server && server.close(done);
    });
    it("handles invalid JSON-RPC responses", async () => {
      const { localProvider } = await startLocalChain(port, {
        url: `http://0.0.0.0:${port}`
      });
      // some bad values to test
      const junks = [
        null,
        "",
        "a string",
        1234,
        { invalid: ["json-rpc"] },
        {},
        -9
      ];
      for (let j of junks) {
        junk = j;
        await assert.rejects(
          () =>
            localProvider.request({
              // the mock server returns junk for calls to `eth_getBalance`
              method: "eth_getBalance" as any,
              params: ["0x2000000000000000000000000000000000000000"]
            }),
          {
            message: `Invalid response from fork provider: \`${JSON.stringify(
              junk
            )}\``
          }
        );
      }
    });
  });

  describe("providers", () => {
    it("throws on invalid provider", async () => {
      await assert.rejects(
        () =>
          startLocalChain(PORT, {
            url: null,
            provider: { request: "not a function" }
          }),
        { message: "Forking `provider` must be EIP-1193 compatible" }
      );
      await assert.rejects(
        () =>
          startLocalChain(PORT, {
            url: null,
            provider: { send: "also not a function" }
          }),
        { message: "Forking `provider` must be EIP-1193 compatible" }
      );
    });

    describe("EIP-1193 providers", () => {
      let localProvider: EthereumProvider;
      beforeEach(
        "start up localProvider fork with remoteProvider",
        async () => {
          const provider = await startLocalChain(PORT, {
            url: null,
            provider: remoteProvider
          });
          localProvider = provider.localProvider;
        }
      );

      afterEach(async () => {
        try {
          localProvider && (await localProvider.disconnect());
        } catch (e) {
          console.log(e);
        }
      });

      it("should accept a provider instead of a url", async () => {
        const [remoteNetworkId, localNetworkId] = await Promise.all(
          [remoteProvider, localProvider].map(p => p.send("net_version", []))
        );
        assert.strictEqual(localNetworkId, remoteNetworkId);
      });

      it("should handle non json-rpc errors", async () => {
        // force remoteProvider.send to fail
        (remoteProvider as any).request = () => {
          return Promise.reject(new Error("Regular error"));
        };

        await assert.rejects(
          () =>
            localProvider.request({
              method: "eth_getBalance",
              params: ["0x2000000000000000000000000000000000000000"]
            }),
          { message: "Regular error" }
        );
      });

      it("should handle json-rpc errors", async () => {
        // force remoteProvider.send to fail
        (remoteProvider as any).request = () => {
          return Promise.reject(new CodedError("Coded error", 1234));
        };

        await assert.rejects(
          () =>
            localProvider.request({
              method: "eth_getBalance",
              params: ["0x2000000000000000000000000000000000000000"]
            }),
          { message: "Coded error", code: 1234 }
        );
      });
    });

    describe("legacy provider", () => {
      let localProvider: EthereumProvider;
      let onSend: (...args: any) => any;
      beforeEach("set up legacy provider", async () => {
        // remove our EIP-1193 request method so we can test how forking treats
        // legacy providers:
        const request = remoteProvider.request;
        (remoteProvider as any).request = undefined;

        const send = remoteProvider.send;
        remoteProvider.send = (...args: any) => {
          onSend && onSend(args);
          // now that forking has initialized we need to put the `request` method
          // back because `provider.send` uses it internally :-)
          if (!(remoteProvider as any).request) {
            (remoteProvider as any).request = request;
          }
          return send.apply(remoteProvider, args);
        };

        const provider = await startLocalChain(PORT, {
          url: null,
          provider: remoteProvider
        });
        localProvider = provider.localProvider;

        // initialize the send method
        localProvider.request({
          method: "eth_getBalance",
          params: ["0x1000000000000000000000000000000000000000"]
        });
      });
      afterEach(async () => {
        try {
          localProvider && (await localProvider.disconnect());
        } catch (e) {
          console.log(e);
        }
      });

      it("should accept a legacy provider instead of a url", async () => {
        // eavesdrops on `provider.send` to make sure it is actually being used by
        // this test.
        let sendCalled = false;
        onSend = () => {
          sendCalled = true;
        };

        await localProvider.request({
          method: "eth_getBalance",
          params: ["0x2000000000000000000000000000000000000000"]
        });
        assert(sendCalled, "remoteProvider.send wasn't called!");
      });

      it("should handle non json-rpc errors", async () => {
        // force remoteProvider.send to fail
        (remoteProvider as any).send = (_request, callback) => {
          callback(new Error("Regular error"));
        };

        await assert.rejects(
          () =>
            localProvider.request({
              method: "eth_getBalance",
              params: ["0x2000000000000000000000000000000000000000"]
            }),
          { message: "Regular error" }
        );
      });

      it("should handle json-rpc errors", async () => {
        // force remoteProvider.send to fail
        (remoteProvider as any).send = (_request, callback) => {
          callback(new CodedError("Coded error", 1234));
        };

        await assert.rejects(
          () =>
            localProvider.request({
              method: "eth_getBalance",
              params: ["0x2000000000000000000000000000000000000000"]
            }),
          { message: "Coded error", code: 1234 }
        );
      });
    });
  });

  describe("initial state", () => {
    it("should get the Network ID of the forked chain", async () => {
      const { localProvider } = await startLocalChain(PORT);

      const [remoteNetworkId, localNetworkId] = await Promise.all(
        [remoteProvider, localProvider].map(p => p.send("net_version", []))
      );
      assert.strictEqual(localNetworkId, remoteNetworkId);
      assert.strictEqual(remoteNetworkId, NETWORK_ID.toString());
    });

    it("should fork at the specified block number", async () => {
      const blocks = 10;
      await remoteProvider.request({
        method: "evm_mine",
        params: [{ blocks }]
      });
      const remoteBlockNumber = parseInt(
        await remoteProvider.request({ method: "eth_blockNumber", params: [] }),
        16
      );
      assert.strictEqual(remoteBlockNumber, 10);
      const localStartBlockNum = blocks / 2;
      const { localProvider } = await startLocalChain(PORT, {
        blockNumber: localStartBlockNum
      });

      const localBlockNumber = parseInt(
        await localProvider.request({
          method: "eth_blockNumber",
          params: []
        })
      );

      assert.strictEqual(localBlockNumber, localStartBlockNum + 1);

      // and let's make sure we can get a block that exists after our for block number
      const localBlock = await localProvider.request({
        method: "eth_getBlockByNumber",
        params: ["0x" + remoteBlockNumber.toString(16), false]
      });
      assert.strictEqual(localBlock, null);
    });

    describe("block number", () => {
      let localProvider: EthereumProvider;
      beforeEach("start local chain", async () => {
        ({ localProvider } = await startLocalChain(PORT));
      });

      it("local block number should be 1 after the remote block on start up", async () => {
        const [remoteBlock, localBlock] = await Promise.all(
          [remoteProvider, localProvider].map(provider =>
            provider.send("eth_blockNumber", [])
          )
        );
        assert.strictEqual(BigInt(localBlock), BigInt(remoteBlock) + 1n);
      });
    });

    describe("nonces", () => {
      let localProvider: EthereumProvider;
      beforeEach("update remote's accounts' nonces", async () => {
        await updateRemotesAccountNonces(remoteProvider, remoteAccounts);
      });

      beforeEach("start local chain", async () => {
        ({ localProvider } = await startLocalChain(PORT));
      });

      it("should return the nonce of each account", async () => {
        // fetch the nonce of each account on the remote chain via the local chain
        await Promise.all(
          remoteAccounts.map((account, i) =>
            localProvider
              .request({ method: "eth_getTransactionCount", params: [account] })
              .then(nonce => {
                assert.strictEqual(nonce, `0x${(i + 1).toString(16)}`);
              })
          )
        );
      });
    });

    describe("balances", () => {
      let localProvider: EthereumProvider;
      let localAccounts: string[];
      beforeEach("update remote's accounts' balances", async () => {
        await updateRemotesAccountsBalances(remoteProvider, remoteAccounts);
      });

      beforeEach("start local chain", async () => {
        ({ localProvider, localAccounts } = await startLocalChain(PORT));
      });

      it("should use `defaultBalanceEther` for balance of the initial accounts on the local chain", async () => {
        // fetch the nonce of each account on the remote chain via the local chain
        const options = localProvider.getOptions();
        await Promise.all(
          localAccounts.map(account =>
            localProvider.send("eth_getBalance", [account]).then(balance => {
              assert.strictEqual(
                BigInt(balance),
                WEI * BigInt(options.wallet.defaultBalance)
              );
            })
          )
        );
      });

      it("should NOT overwrite the `value` of the deterministic accounts that aren't on the local chain", async () => {
        // the remote chain is started with `REMOTE_ACCOUNT_COUNT` (15) accounts,
        // whereas the local chain is started with the default: 10
        assert(localAccounts.length < remoteAccounts.length);

        await Promise.all(
          // test only the accounts from the remote that we didn't also set up on the local chain
          remoteAccounts
            .slice(localAccounts.length - remoteAccounts.length) // a negative number
            .map(account =>
              Promise.all(
                [remoteProvider, localProvider].map(p =>
                  p.send("eth_getBalance", [account])
                )
              ).then(([remoteBalance, localBalance]) => {
                assert.strictEqual(localBalance, remoteBalance);
              })
            )
        );
      });
    });
  });

  describe("state changes", () => {
    let contractAddress: string;
    let methods: {
      [methodName: string]: string;
    };
    let contractCode: string;
    let contractBlockNum: number;

    function get(
      localProvider: EthereumProvider,
      value: string,
      blockNum: number
    ) {
      return localProvider.send("eth_call", [
        {
          from: remoteAccounts[0],
          to: contractAddress,
          data: `0x${methods[`${value}()`]}`
        },
        `0x${blockNum.toString(16)}`
      ]);
    }

    async function getBlockRanges(provider: EthereumProvider) {
      // our local chain starts at `localBlockNumberStart`.
      const blockNum = parseInt(await provider.send("eth_blockNumber", []), 16);
      assert.strictEqual(
        contractBlockNum,
        1,
        "Failed sanity check; contract block number should be 1. Adjust test and check test to fix."
      );
      assert.strictEqual(
        blockNum,
        2,
        "Failed sanity check; local starting block number should be 2. Adjust test and check test to fix."
      );

      const blockNumbersWithCode = range(contractBlockNum, blockNum);
      const blockNumbersWithoutCode = range(0, contractBlockNum - 1);

      return { blockNum, blockNumbersWithCode, blockNumbersWithoutCode };
    }

    async function checkOriginalData(
      blockNumsWithCode: number[],
      get: (key: string, blockNum: number) => Promise<string>
    ) {
      return Promise.all(
        blockNumsWithCode.map(async blockNum => {
          const value0 = await get("value0", blockNum);
          assert.strictEqual(parseInt(value0, 16), 0);

          const value1 = await get("value1", blockNum);
          assert.strictEqual(parseInt(value1, 16), 2);

          const value2 = await get("value2", blockNum);
          assert.strictEqual(parseInt(value2, 16), 1);

          const value3 = await get("value3", blockNum);
          assert.strictEqual(parseInt(value3, 16), 0);

          const value4 = await get("value4", blockNum);
          assert.strictEqual(parseInt(value4, 16), 1);
        })
      );
    }

    async function checkRangeForValue(
      blockNums: number[],
      value: string,
      get: (key: string, blockNum: number) => Promise<string>
    ) {
      return Promise.all(
        blockNums.map(blockNum =>
          range(0, 4).map(i =>
            get(`value${i}`, blockNum).then(v =>
              assert.strictEqual(
                v,
                value,
                `Incorrect value at block ${blockNum} for value${i}: ${v}`
              )
            )
          )
        )
      );
    }

    async function setAllValuesTo(
      provider: EthereumProvider,
      value: number,
      set: (key: number, value: number) => Promise<string>
    ) {
      // `set` the values 0-4 (value0, value1, etc), to `9`
      await provider.send("miner_stop");
      const subId = await provider.send("eth_subscribe", ["newHeads"]);
      const hashes = await Promise.all(
        Array.from({ length: 5 }, (_, i) => set(i, value))
      );
      await provider.send("miner_start");
      await provider.once("message");
      await provider.send("eth_unsubscribe", [subId]);
      await Promise.all(
        hashes.map(hash => provider.send("eth_getTransactionReceipt", [hash]))
      ).then(receipts =>
        receipts.forEach(receipt => {
          assert.notStrictEqual(receipt, null);
          assert.strictEqual(receipt.status, "0x1");
        })
      );
    }

    beforeEach("deploy contract", async () => {
      const contract = compile(
        path.join(__dirname, "contracts", "Forking.sol")
      );
      const subscriptionId = await remoteProvider.send("eth_subscribe", [
        "newHeads"
      ]);
      const deploymentHash = await remoteProvider.send("eth_sendTransaction", [
        {
          from: remoteAccounts[0],
          data: contract.code,
          gas: `0x${(3141592).toString(16)}`
        }
      ]);
      await remoteProvider.once("message");
      await remoteProvider.send("eth_unsubscribe", [subscriptionId]);
      const deploymentTxReceipt = await remoteProvider.send(
        "eth_getTransactionReceipt",
        [deploymentHash]
      );
      ({ contractAddress } = deploymentTxReceipt);
      contractBlockNum = parseInt(deploymentTxReceipt.blockNumber, 16);
      methods = contract.contract.evm.methodIdentifiers;

      contractCode = await remoteProvider.send("eth_getCode", [
        contractAddress
      ]);
    });

    it("should fetch contract code from the remote chain via the local chain", async () => {
      const { localProvider } = await startLocalChain(PORT);
      const {
        blockNumbersWithCode,
        blockNumbersWithoutCode
      } = await getBlockRanges(localProvider);

      await Promise.all(
        blockNumbersWithCode.map(blockNumber =>
          localProvider
            .send("eth_getCode", [
              contractAddress,
              `0x${blockNumber.toString(16)}`
            ])
            .then(code => assert.strictEqual(code, contractCode))
        )
      );

      await Promise.all(
        blockNumbersWithoutCode.map(blockNumber =>
          localProvider
            .send("eth_getCode", [
              contractAddress,
              `0x${blockNumber.toString(16)}`
            ])
            .then(code => assert.strictEqual(code, "0x"))
        )
      );
    });

    it("should fetch initial contract data from the remote chain via the local chain", async () => {
      const { localProvider } = await startLocalChain(PORT);
      const {
        blockNum,
        blockNumbersWithCode,
        blockNumbersWithoutCode
      } = await getBlockRanges(localProvider);

      const _get = (value: string, blockNum: number) =>
        get(localProvider, value, blockNum);

      await Promise.all(
        blockNumbersWithCode.map(async blockNumber => {
          const value0 = await _get("value0", blockNumber);
          assert.strictEqual(parseInt(value0, 16), 0);

          const value1 = await _get("value1", blockNumber);
          assert.strictEqual(parseInt(value1, 16), 2);

          const value2 = await _get("value2", blockNumber);
          assert.strictEqual(parseInt(value2, 16), 1);

          const value3 = await _get("value3", blockNumber);
          assert.strictEqual(parseInt(value3, 16), 0);

          const value4 = await _get("value4", blockNumber);
          assert.strictEqual(parseInt(value4, 16), 1);
        })
      );

      await Promise.all(
        blockNumbersWithoutCode.map(async blockNumber => {
          const value0 = await _get("value0", blockNumber);
          assert.strictEqual(value0, "0x");

          const value1 = await _get("value1", blockNumber);
          assert.strictEqual(value1, "0x");

          const value2 = await _get("value2", blockNumber);
          assert.strictEqual(value2, "0x");

          const value3 = await _get("value3", blockNumber);
          assert.strictEqual(value3, "0x");

          const value4 = await _get("value4", blockNumber);
          assert.strictEqual(value4, "0x");
        })
      );
    });

    it("should fetch changed contract data from the remote chain via the local chain", async () => {
      const { localProvider } = await startLocalChain(PORT);
      const {
        blockNum,
        blockNumbersWithCode,
        blockNumbersWithoutCode
      } = await getBlockRanges(localProvider);

      function set(key: number, value: number) {
        const encodedKey = Quantity.from(key)
          .toBuffer()
          .toString("hex")
          .padStart(64, "0");
        const encodedValue = Quantity.from(value)
          .toBuffer()
          .toString("hex")
          .padStart(64, "0");

        return localProvider.send("eth_sendTransaction", [
          {
            from: remoteAccounts[0],
            to: contractAddress,
            data: `0x${
              methods[`setValueFor(uint8,uint256)`]
            }${encodedKey}${encodedValue}`,
            gas: `0x${(3141592).toString(16)}`
          }
        ]);
      }

      const _get = (value: string, blockNum: number) =>
        get(localProvider, value, blockNum);

      await setAllValuesTo(localProvider, 9, set);

      const postNineBlockNum = parseInt(
        await localProvider.send("eth_blockNumber", []),
        16
      );
      const blockNumsAfterNine = range(blockNum + 1, postNineBlockNum);

      // the blocks created before the `set` should still have the original values
      await checkOriginalData(blockNumbersWithCode, _get);

      // the pre-contract blocks should still have no values
      await checkRangeForValue(blockNumbersWithoutCode, "0x", _get);

      const nine =
        "0x0000000000000000000000000000000000000000000000000000000000000009";
      await checkRangeForValue(blockNumsAfterNine, nine, _get);

      // set all values to 0 (the EVM treats this as a "delete")
      await setAllValuesTo(localProvider, 0, set);

      const postZeroBlockNum = parseInt(
        await localProvider.send("eth_blockNumber", []),
        16
      );
      const blockNumsAfterZero = range(postNineBlockNum + 1, postZeroBlockNum);

      // the pre-contract blocks should still have no values
      await checkRangeForValue(blockNumbersWithoutCode, "0x", _get);

      // the blocks created before the `set` should still have the original values
      await checkOriginalData(blockNumbersWithCode, _get);

      // post-nine-blocks that are pre-zero should still be set to nine
      await checkRangeForValue(blockNumsAfterNine, nine, _get);

      // after setting all values to zero, the values should be zero!
      const zero =
        "0x0000000000000000000000000000000000000000000000000000000000000000";
      await checkRangeForValue(blockNumsAfterZero, zero, _get);

      // set all values to 11
      await setAllValuesTo(localProvider, 11, set);

      const postElevenBlockNum = parseInt(
        await localProvider.send("eth_blockNumber", []),
        16
      );
      const blockNumsAfterEleven = range(
        postZeroBlockNum + 1,
        postElevenBlockNum
      );

      // the pre-contract blocks should still have no values
      await checkRangeForValue(blockNumbersWithoutCode, "0x", _get);

      // the blocks created before the `set` should still have the original values
      await checkOriginalData(blockNumbersWithCode, _get);

      // post-nine-blocks that are pre-zero should still be set to nine
      await checkRangeForValue(blockNumsAfterNine, nine, _get);

      //  the values should still be zero!
      await checkRangeForValue(blockNumsAfterZero, zero, _get);

      // after setting all values to a number again (11), the values should be 11!
      const eleven =
        "0x000000000000000000000000000000000000000000000000000000000000000b";
      await checkRangeForValue(blockNumsAfterEleven, eleven, _get);
    });
  });

  describe("blocks", () => {
    let localProvider: EthereumProvider;
    beforeEach("start local chain", async () => {
      const [from, to] = remoteAccounts;
      const tx = {
        from,
        to
      };
      const subId = await remoteProvider.send("eth_subscribe", ["newHeads"]);
      await remoteProvider.send("eth_sendTransaction", [tx]);
      await remoteProvider.once("message");
      await remoteProvider.send("eth_unsubscribe", [subId]);

      ({ localProvider } = await startLocalChain(PORT));
    });

    it("ensure local block's latest matches remote block's latest (with transaction)", async () => {
      const [remoteBlock, localBlock] = await Promise.all(
        [remoteProvider, localProvider].map(provider =>
          provider.send("eth_getBlockByNumber", ["0x1", true])
        )
      );
      assert.deepStrictEqual(localBlock, remoteBlock);
    });
  });
});
