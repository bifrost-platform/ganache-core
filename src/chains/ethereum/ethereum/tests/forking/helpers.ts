import getProvider from "../helpers/getProvider";
import Server from "../../../../../packages/core/lib/src/server";
import EthereumProvider from "../../src/provider";

export const logging = {
  logger: {
    log: () => {}
  }
};

export const updateRemotesAccountsBalances = async (
  remoteProvider: EthereumProvider,
  remoteAccounts: string[]
) => {
  const subscription = await remoteProvider.send("eth_subscribe", ["newHeads"]);
  // send some ether from each account to another account
  await remoteProvider.send("miner_stop", []);
  await Promise.all(
    remoteAccounts.map((account, i) =>
      remoteProvider.send("eth_sendTransaction", [
        {
          from: account,
          // send to the next account (if we've reached the last account, send to the first)
          to: remoteAccounts[i + 1] || remoteAccounts[0],
          // send a different value for each account
          value: `0x${(i + 1 * 10000000).toString(16)}`
        }
      ])
    )
  );
  await remoteProvider.send("miner_start", []);
  await remoteProvider.once("message");
  await remoteProvider.send("eth_unsubscribe", [subscription]);
};

export const updateRemotesAccountNonces = async (
  remoteProvider: EthereumProvider,
  remoteAccounts: string[]
) => {
  // sets different starting nonces for each account
  await Promise.all(
    remoteAccounts.map((account, i) =>
      remoteProvider.send("evm_setAccountNonce", [
        account,
        `0x${(i + 1).toString(16)}`
      ])
    )
  );
};

export const startLocalChain = async (port: number, options?: any) => {
  const localProvider = await getProvider({
    logging,
    fork: { url: `ws://0.0.0.0:${port}`, ...options },
    wallet: { deterministic: true }
  });
  return {
    localAccounts: Object.keys(localProvider.getInitialAccounts()),
    localProvider
  };
};

/**
 *
 * @param min min number, inclusive
 * @param max min number, inclusive
 */
export function range(min: number, max: number) {
  return Array.from({ length: 1 + max - min }, (_, k) => k + min);
}
