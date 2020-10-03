/* eslint-disable no-multi-assign */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-use-before-define */
// usage: ./tally.sh [ballotfile] [transaction-server:port]
// https://github.com/rchain-community/rv2020/issues/35
// an account is counted only once for a choice.
// The case of a person voting for multiple choices the most recent is used.
// the check for the account being allowed to vote is not handled.

// @ts-check

const { assert } = require('console');

const jq = JSON.parse;

/**
 * @param {string[]} argv
 * @param {{ fsp: any, http: any, echo: (txt: string) => void }} powers
 */
async function main(argv, { fsp, http, echo }) {
  // console.log(argv);
  // TODO: consider docopt if this gets more complex
  const ballot = argv.length >= 3 ? argv[2] : 'ballotexample.json';
  const server = argv.length >= 4 ? argv[3] : 'kc-strip.madmode.com:7070';

  const ballotData = JSON.parse(await fsp.readFile(ballot, 'utf8'));

  let whichCurl = (url) => nodeCurl(url, { http });

  if (argv.includes('--test')) {
    runTests(ballotData, { fsp });
    return;
  } else if (argv.includes('--cache')) {
    whichCurl = cachingCurl(',cache', { fsp });
  }

  const perItem = await tally(ballotData, server, { curl: whichCurl, echo });
  console.log(perItem);
}

function cachingCurl(dirname, { fsp }) {
  const toCache = (url) => `${dirname}/${url.slice(-20)}`;

  return async (url, { http }) => {
    const contents = await nodeCurl(url, { http });
    assert(url.match('/api/transfer/'));
    await fsp.writeFile(toCache(url), contents);
    return contents;
  };
}

function curlFromCache(dirname, { fsp }) {
  const toCache = (url) => `../../test/${dirname}/${url.slice(-20)}`;
  const curl = async (url, _powers) => {
    // console.log('look ma, no network!', url);
    return fsp.readFile(toCache(url), 'utf8');
  };
  return curl;
}

// TODO: move this from ./src to ./test
const testSuite = [
  {
    dirname: 'test-dup-order',
    expected: {
      'Member Swag': { yes: 1, no: 1 },
      'Board: DaD': { yes: 1, no: 2 },
      'Board: DoD': { yes: 1, no: 2 },
      'Board: WEC': { yes: 2, no: 2 },
      'Board: RR': { yes: 2, no: 1 },
    },
  },
];

// TODO: move this from ./src to ./test
/**
 * @typedef {{[refID: string]: { shortDesc: string, docLink?: string, yesAddr: string, noAddr: string }}} QAs
 * @param {QAs} ballotData
 */
async function runTests(ballotData, { fsp }) {
  // TODO: ballot data should be part of test input
  for (const testCase of testSuite) {
    let result = 'pass';
    const { dirname, expected } = testCase;
    const curl = curlFromCache(dirname, { fsp });
    const actual = await tally(ballotData, 'TEST_SERVER', {
      curl,
      echo: console.log,
    });
    // console.log(JSON.stringify({ actual, expected }, null, 2));
    for (const [id, value] of Object.entries(expected)) {
      if (actual[id].yes !== value.yes) {
        console.error({
          id,
          field: 'yes',
          expected: value.yes,
          actual: actual[id].yes,
        });
        result = 'FAIL';
      }
      if (actual[id].no !== value.no) {
        console.error({
          id,
          field: 'no',
          expected: value.no,
          actual: actual[id].no,
        });
        result = 'FAIL';
      }
    }
    console.log({ dirname, result });
  }
}

/**
 * @param {QAs} ballotData
 * @param {string} server
 * @param {{ curl: (url: string) => Promise<string>, echo: (txt: string) => void }} powers
 */
async function tally(ballotData, server, { curl, echo }) {
  // console.log('ballot:', ballotData);

  // const lastblock = '???????'; // when election is over

  const voteData = await voteTransactions(ballotData, server, { curl });

  const perItem = {};

  /** @type { (items: string[]) => string[] } */
  const uniq = (items) => Array.from(new Set(items).values());
  /** @type { (as: string[], bs: string[]) => Set<string> } */
  const intersection = (as, bs) =>
    ((bss) => new Set(as.filter((x) => bss.has(x))))(new Set(bs));

  for (const [id, item] of Object.entries(ballotData)) {
    const { shortDesc: desc, yesAddr, noAddr } = item;
    echo(desc);

    const yesVotes = uniq(voteData[id].yes.map((tx) => tx.fromAddr));
    let yes = yesVotes.length;
    const noVotes = uniq(voteData[id].no.map((tx) => tx.fromAddr));
    let no = noVotes.length;
    perItem[id] = { yes, no };
    echo(`  ${yes} yes votes ${yesAddr}`);
    echo(`  ${no} no votes ${noAddr}`);

    const double = Array.from(intersection(yesVotes, noVotes));
    if (double.length !== 0) {
      echo(` ALERT: ${double} voted both yes and no.`);
      const doubleVotes = await voterTransactions(double, server, { curl });
      for (const voter of double) {
        for (const acct of doubleVotes[voter].map((tx) => tx.toAddr)) {
          if (acct === yesAddr) {
            // echo(`yes found`)
            perItem[id].no = no -= 1;
            break;
          } else if (acct === noAddr) {
            //  echo no found
            perItem[id].yes = yes -= 1;
            break;
          }
        }
      }
      echo(`  ${yes} yes votes ${yesAddr}`);
      echo(`  ${no} no votes ${noAddr}`);
    }
  }
  return perItem;
}

/**
 * @typedef {{ fromAddr: string, toAddr: string }} TX
 * @param {QAs} ballotData
 * @param {string} server
 * @param {{ curl: (url: string) => Promise<string> }} powers
 * @returns {Promise<{[id: string]: { yes: TX[], no: TX[] }}>}
 */
async function voteTransactions(ballotData, server, { curl }) {
  /** @type { {[id: string]: { yes: TX[], no: TX[] }} } */
  const votes = {};
  for (const [id, item] of Object.entries(ballotData)) {
    const { yesAddr, noAddr } = item;

    votes[id] = {
      yes: jq(await curl(`http://${server}/api/transfer/${yesAddr}`)),
      no: jq(await curl(`http://${server}/api/transfer/${noAddr}`)),
    };
  }
  return votes;
}

/**
 * @param {string[]} fromAddrs
 * @param {string} server
 * @param {{ curl: (url: string) => Promise<string> }} powers
 * @returns { Promise<{[voter: string]: TX[] }>}
 */
async function voterTransactions(fromAddrs, server, { curl }) {
  /** @type { {[voter: string]: TX[] } } */
  const byVoter = {};
  for (const voter of fromAddrs) {
    byVoter[voter] = jq(await curl(`http://${server}/api/transfer/${voter}`));
  }
  return byVoter;
}

/**
 * @param {string} url
 * @param {{ http: any }} powers
 * @returns {Promise<string>}
 */
function nodeCurl(url, { http }) {
  // console.log('get', { url });
  return new Promise((resolve, reject) => {
    const req = http.get(url, (response) => {
      let str = '';
      // console.log('Response is ' + response.statusCode);
      response.on('data', (chunk) => {
        str += chunk;
      });
      response.on('end', () => resolve(str));
    });
    req.end();
    req.on('error', reject);
  });
}

if (require.main === module) {
  main(process.argv, {
    // eslint-disable-next-line global-require
    fsp: require('fs').promises,
    // eslint-disable-next-line global-require
    http: require('http'),
    echo: console.log,
  }).catch((err) => console.error(err));
}
