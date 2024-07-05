const TelegramBot = require('node-telegram-bot-api');
const {
  toFile
} = require('qrcode');
const {
  fileSync
} = require('tmp');
const fs = require('fs');
const {
  ethers,
  constants
} = require('ethers');
const dotenv = require('dotenv');

dotenv.config();

process.noDeprecation = true; // Ignore deprecation warnings

// Setting up Ethereum provider
const provider = new ethers.JsonRpcProvider(`${process.env.ETHEREUM_RPC_URL}`);

// Setting up bot API token
const token = `${process.env.TG_API_KEY}`;
const bot = new TelegramBot(token, {
  polling: true
});

// Handling polling errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
  // Retry mechanism
  setTimeout(() => {
    bot.startPolling();
  }, 10000); // Retry after 10 seconds
});

// Set to track first-time users
const users = new Set();
const activeRequests = new Map(); // Track active requests

// Mapping chain IDs
const chainIds = {
  'Base': '84532',
  'Optimism': '11155420',
  'Blast': '168587773',
  'Scroll': '534351',
  'Zksync': '300'
};

// Setting timeout duration (milliseconds)
const TIMEOUT_DURATION = 600000; // 10 minutes

// Function to show main menu
function showMainMenu(chatId) {
  clearRequestTimeout(chatId); // Clear timeout in main menu
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

// Function to set request timeout
function setRequestTimeout(chatId) {
  clearRequestTimeout(chatId); // Clear existing timeout
  const timeout = setTimeout(() => {
    bot.sendMessage(chatId, "Timeout occurred. Please start again.");
    showMainMenu(chatId);
    activeRequests.delete(chatId);
  }, TIMEOUT_DURATION);
  activeRequests.set(chatId, timeout);
}

// Function to clear request timeout
function clearRequestTimeout(chatId) {
  if (activeRequests.has(chatId)) {
    clearTimeout(activeRequests.get(chatId));
    activeRequests.delete(chatId);
  }
}

// Function to get wallet address
async function getWalletAddress(ensName) {
  console.log('Getting wallet address for ENS name:', ensName);
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

// Handler for start command
bot.onText(/\/start/, (msg) => {
  console.log('Start command received');

  const chatId = msg.chat.id;
  console.log('Chat ID:', chatId);
  if (!users.has(chatId)) {
    bot.sendMessage(chatId, "Welcome to the Magic Transfer beta! You can easily request testnet tokens without connecting a wallet.");
    users.add(chatId);
  }
  showMainMenu(chatId);
});

// Message handler
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
          text: 'Base'
        }],
        [{
          text: 'Optimism'
        }],
        [{
          text: 'Blast'
        }],
        [{
          text: 'Scroll'
        }],
        [{
          text: 'Zksync'
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
    console.log('Chain selected:', chain);
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
      return; // Do not proceed after cancel
    }

    if (activeRequests.has(chatId)) { // Do not ask for amount again on timeout
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
      return; // Do not proceed after cancel
    }

    if (activeRequests.has(chatId)) { // Do not ask for address again on timeout
      let address = msg.text;
      if (address.length === 42 && address.startsWith('0x')) {
        // Ethereum address validation successful
        handleValidAddress(chain, chatId, amount, address);
      } else if (address.endsWith('.eth')) {
        // Attempt to resolve ENS name
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
  console.log('Transfer link:', url);
  bot.sendMessage(chatId, `Here is your transfer link: ${url}`);

  // Generate QR code and save to temporary file
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
      tmpFile.removeCallback(); // Remove temporary file after sending
    }).catch((error) => {
      bot.sendMessage(chatId, 'Failed to send QR Code.');
      console.error('Failed to send QR Code:', error);
    });
  });

  activeRequests.delete(chatId); // Clear timeout after completion
  showMainMenu(chatId);
}

console.log('Bot is running...');