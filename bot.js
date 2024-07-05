import TelegramBot from 'node-telegram-bot-api';
import {
  toFile
} from 'qrcode';
import {
  fileSync
} from 'tmp';
import fs from 'fs';
import {
  ethers,
  constants
} from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

process.noDeprecation = true; // 非推奨警告を無視

// Ethereumプロバイダーの設定
const provider = new ethers.JsonRpcProvider(`${process.env.ETHEREUM_RPC_URL}`);

// ENSアドレスを解決する関数
async function resolveENSName(name, chatId) {
  try {
    bot.sendMessage(chatId, `Searching for ENS name: ${name}`);
    const address = await provider.resolveName(name);
    if (address && address !== constants.AddressZero) {
      bot.sendMessage(chatId, `Found address: ${address}`);
      return address;
    } else {
      bot.sendMessage(chatId, `No address found for ENS name: ${name}`);
      return null;
    }
  } catch (error) {
    bot.sendMessage(chatId, `Failed to resolve ENS name: ${name}`);
    console.error('Failed to resolve ENS name:', error);
    return null;
  }
}

// BotのAPIトークンを設定
const token = `${process.env.TG_API_KEY}`;
const bot = new TelegramBot(token, {
  polling: true
});

// ポーリングエラーの処理
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
  // 再試行のための対策
  setTimeout(() => {
    bot.startPolling();
  }, 10000); // 10秒後に再試行
});

// ユーザーの初回訪問を追跡するためのセット
const users = new Set();
const activeRequests = new Map(); // アクティブなリクエストを追跡

// チェーンIDをマッピング
const chainIds = {
  'Ethereum': '84532',
  'Optimism': '11155420',
  'Arbitrum': '000' // ここは例として '000' を使用します。他のチェーンIDがあれば更新してください。
};

// タイムアウト時間の設定（ミリ秒）
const TIMEOUT_DURATION = 600000; // 10分

// メインメニューを表示する関数
function showMainMenu(chatId) {
  clearRequestTimeout(chatId); // メインメニューではタイムアウトを解除
  bot.sendMessage(chatId, "Choose an option:", {
    reply_markup: {
      keyboard: [
        [{
          text: 'Request Transfer'
        }],
        [{
          text: 'How to Use'
        }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
}

// タイムアウトを設定する関数
function setRequestTimeout(chatId) {
  clearRequestTimeout(chatId); // 既存のタイムアウトをクリア
  const timeout = setTimeout(() => {
    bot.sendMessage(chatId, "Timeout occurred. Please start again.");
    showMainMenu(chatId);
    activeRequests.delete(chatId);
  }, TIMEOUT_DURATION);
  activeRequests.set(chatId, timeout);
}

// タイムアウトをクリアする関数
function clearRequestTimeout(chatId) {
  if (activeRequests.has(chatId)) {
    clearTimeout(activeRequests.get(chatId));
    activeRequests.delete(chatId);
  }
}

// ウォレットアドレスを取得する関数
async function getWalletAddress(ensName) {
  try {
    const address = await provider.resolveName(ensName);
    if (address) {
      console.log(`ENS Name: ${ensName}, Address: ${address}`);
      return address;
    } else {
      console.log(`ENS Name: ${ensName} does not resolve to an address.`);
      return null;
    }
  } catch (error) {
    console.error(`Failed to resolve ENS Name: ${ensName}`, error);
    return null;
  }
}

// スタートコマンドに対するハンドラ
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!users.has(chatId)) {
    bot.sendMessage(chatId, "Welcome to the Magic Transfer beta! You can easily request testnet tokens without connecting a wallet.");
    users.add(chatId);
  }
  showMainMenu(chatId);
});

// メッセージハンドラ
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === 'Request Transfer') {
    askForChain(chatId);
  } else if (text === 'How to Use') {
    bot.sendMessage(chatId, "How to Use: Here you will get the instructions...");
    showMainMenu(chatId);
  } else if (text.startsWith('/start')) {
    // Ignore since handled in bot.onText handler
  } else if (text === 'Cancel') {
    bot.sendMessage(chatId, "Request cancelled.");
    showMainMenu(chatId);
    clearRequestTimeout(chatId);
    return;



  } else {
    // Ignore other text messages for now
  }
});

function askForChain(chatId) {
  bot.sendMessage(chatId, "Which chain would you like to receive on?", {
    reply_markup: {
      keyboard: [
        [{
          text: 'Ethereum'
        }],
        [{
          text: 'Arbitrum'
        }],
        [{
          text: 'Optimism'
        }],
        [{
          text: 'Cancel'
        }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
  setRequestTimeout(chatId);
  bot.once('message', (msg) => {
    const chain = msg.text;
    if (chainIds[chain]) {
      askForAmount(chain, chatId);
    } else {
      showMainMenu(chatId);
    }
  });
}

function askForAmount(chain, chatId) {
  bot.sendMessage(chatId, "How much would you like to receive? (Maximum 0.1ETH)");
  setRequestTimeout(chatId);
  const messageHandler = (msg) => {
    if (msg.text === 'Cancel') {
      bot.sendMessage(chatId, "Request cancelled.");
      showMainMenu(chatId);
      clearRequestTimeout(chatId);
      return; // Cancel処理後、次の処理をしないようにする
    }

    if (activeRequests.has(chatId)) { // タイムアウト時に再度数量を聞かないようにする
      const amount = parseFloat(msg.text);
      if (isNaN(amount) || amount > 0.1 || amount <= 0) {
        bot.sendMessage(chatId, "Please enter a valid amount up to 0.1ETH.");
        askForAmount(chain, chatId); // Recurse to ask again
      } else {
        askForWalletAddress(chain, chatId, amount);
      }
    }
  };
  bot.once('message', messageHandler);
}




async function askForWalletAddress(chain, chatId, amount) {
  bot.sendMessage(chatId, "Please provide your wallet address or ENS name.");
  setRequestTimeout(chatId);
  const messageHandler = async (msg) => {
    if (msg.text === 'Cancel') {
      bot.sendMessage(chatId, "Request cancelled.");
      showMainMenu(chatId);
      clearRequestTimeout(chatId);
      return; // Cancel処理後、次の処理をしないようにする
    }

    if (activeRequests.has(chatId)) { // タイムアウト時に再度アドレスを聞かないようにする
      let address = msg.text;
      if (address.length === 42 && address.startsWith('0x')) {
        // Ethereumアドレスのバリデーションに成功
        handleValidAddress(chain, chatId, amount, address);
      } else if (address.endsWith('.eth')) {
        // ENS名前の解決を試みる
        const resolvedAddress = await getWalletAddress(address);
        if (resolvedAddress) {
          handleValidAddress(chain, chatId, amount, resolvedAddress);
        } else {
          bot.sendMessage(chatId, "Invalid ENS name. Please enter a valid wallet address or ENS name.");
          askForWalletAddress(chain, chatId, amount); // Recurse to ask again
        }
      } else {
        bot.sendMessage(chatId, "Please enter a valid wallet address or ENS name.");
        askForWalletAddress(chain, chatId, amount); // Recurse to ask again
      }
    }
  };
  bot.once('message', messageHandler);
}



function handleValidAddress(chain, chatId, amount, address) {
  const chainId = chainIds[chain] || '000';
  const url = `https://miki-frontend.vercel.app/transfer?amount=${amount}&recipient=${address}&chainId=${chainId}`;
  bot.sendMessage(chatId, `Here is your transfer link: ${url}`);

  // QRコードを生成して一時ファイルに保存し、送信
  const tmpFile = fileSync({
    postfix: '.png'
  });
  toFile(tmpFile.name, url, (err) => {
    if (err) {
      bot.sendMessage(chatId, 'Failed to generate QR Code.');
      return console.error('Failed to create QR Code:', err);
    }
    bot.sendPhoto(chatId, tmpFile.name, {}, {
      contentType: 'image/png'
    }).then(() => {
      tmpFile.removeCallback(); // 送信後に一時ファイルを削除
    }).catch((error) => {
      bot.sendMessage(chatId, 'Failed to send QR Code.');
      console.error('Failed to send QR Code:', error);
    });
  });

  activeRequests.delete(chatId); // 完了後、タイムアウトを解除
  showMainMenu(chatId);
}