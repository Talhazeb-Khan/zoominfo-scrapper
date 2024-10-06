// electron/index.ts

import { app, BrowserWindow, ipcMain, nativeTheme, shell, dialog } from 'electron';
import { join } from 'path';
import path from "node:path";
import isDev from 'electron-is-dev';
import axios from 'axios';
import fs from 'fs';
import { stringify } from 'csv-stringify';
import { ScrapeData } from './preload';


let mainWindow: BrowserWindow | null = null;
let isScraping = false;
let isPaused = false;
let scrapeData: ScrapeData | null = null;
let wasStopped = false;
let delayCancel: (() => void) | null = null;


function createWindow() {

  const iconName = process.platform === 'darwin' ? 'logo.icns' : 'logo.ico';
  let iconPath: string;

  if (app.isPackaged) {
    iconPath = path.join(process.resourcesPath, iconName);
  } else {
    iconPath = path.join(process.cwd(), 'public', iconName);
  }

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remove the default menu bar
  mainWindow.setMenuBarVisibility(false);

  const url = isDev
    ? `http://localhost:3000`
    : `file://${join(__dirname, '../dist-vite/index.html')}`;

  mainWindow.loadURL(url);

  ipcMain.on('start-scraping', (event, data: ScrapeData) => {
    if (isScraping) {
      event.sender.send('error', 'Scraping is already in progress.');
      return;
    }
    isScraping = true;
    isPaused = false;
    wasStopped = false;
    scrapeData = data;
    startScraping();
  });

  ipcMain.on('pause-scraping', () => {
    isPaused = true;
  });

  ipcMain.on('resume-scraping', () => {
    if (isScraping && isPaused) {
      isPaused = false;
    }
  });

  ipcMain.on('stop-scraping', () => {
    isScraping = false;
    isPaused = false;
    wasStopped = true;

    // Cancel any pending delays
    if (delayCancel) {
      delayCancel();
      delayCancel = null;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scraping-stopped');
    }
  });

  ipcMain.on('update-cookies', (_event, newCookies) => {
    if (scrapeData) {
      scrapeData.cookies = newCookies;
      scrapeData.headers = extractHeadersFromCookies(newCookies);
    }
  });

  ipcMain.on('open-file', (_event, filePath: string) => {
    shell.openPath(filePath);
  });

  ipcMain.handle('select-save-path', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow!, {
      title: 'Select Save Location',
      defaultPath: 'data.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    if (canceled) {
      return null;
    } else {
      return filePath;
    }
  });

  ipcMain.handle('file-exists', async (_event, filePath: string) => {
    return fs.existsSync(filePath);
  });

  nativeTheme.themeSource = 'dark';
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

async function startScraping() {
  if (!scrapeData) return;
  const { apiType, cookies, payload, totalResults, savePath } = scrapeData;

  // Extract headers from cookies
  let headers;
  try {
    headers = extractHeadersFromCookies(cookies);
    scrapeData.headers = headers;
  } catch (error) {
    mainWindow?.webContents.send('error', `Error: ${(error as Error).message}`);
    isScraping = false;
    return;
  }

  const writeStream = fs.createWriteStream(savePath, { flags: 'w' });
  const csvStringifier = stringify({ header: true });

  csvStringifier.pipe(writeStream);

  try {
    if (apiType === 'Contact Search') {
      await handleContactSearch(apiType, payload, headers, totalResults, csvStringifier);
    } else {
      await scrapeDataFunction(apiType, payload, headers, totalResults, csvStringifier);
    }

    csvStringifier.end();
    isScraping = false;

    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!wasStopped) {
        mainWindow.webContents.send('scraping-finished');
      }
    }
  } catch (error: any) {
    mainWindow?.webContents.send('error', `Error: ${error.message}`);
  }
}

async function scrapeDataFunction(
  apiType: string,
  payload: any,
  headers: any,
  totalResults: number,
  csvStringifier: any
) {
  const apiUrl = getApiUrl(apiType);
  let resultsCollected = 0;
  let page = 1;

  while (isScraping && resultsCollected < totalResults) {
    if (isPaused) {
      await new Promise((resolve) => {
        const interval = setInterval(() => {
          if (!isPaused) {
            clearInterval(interval);
            resolve(true);
          }
        }, 1000);
      });
    }

    if (!isScraping) {
      break;
    }

    // Update payload with current page
    const updatedPayload = JSON.parse(JSON.stringify(payload)); // Deep copy
    setPageInPayload(updatedPayload, page);

    try {
      const response = await axios.post(apiUrl, updatedPayload, { headers });
      const data = response.data;

      // Handle different API types
      const results = extractResults(apiType, data);

      if (!results || results.length === 0) {
        if (resultsCollected === 0) {
          mainWindow?.webContents.send('error', 'No data found for the given payload.');
        }
        break;
      }

      // Write results to CSV
      for (const result of results) {
        const csvRow = transformResultToCsvRow(apiType, result);
        csvStringifier.write(csvRow);
        resultsCollected += 1;

        // Send progress update
        const progressPercentage = Math.min(
          (resultsCollected / totalResults) * 100,
          100
        );
        mainWindow?.webContents.send('progress-update', {
          progressPercentage,
        });

        if (resultsCollected >= totalResults) {
          break;
        }
      }

      page += 1;

      if (resultsCollected >= totalResults || !isScraping) {
        break;
      }

      // Delay between requests (simulate human behavior)
      const delay = randomDelay(5000, 15000);
      await cancellableDelay(delay);
      if (!isScraping) {
        break;
      }
    } catch (error: any) {
      if (error.response && [401, 403].includes(error.response.status)) {
        mainWindow?.webContents.send('request-new-cookies');
        await waitForCookiesUpdate();
        continue;
      } else {
        mainWindow?.webContents.send('error', `Error: ${error.message}`);
        break;
      }
    }
  }
}

async function handleContactSearch(
  _apiType: string,
  payload: any,
  headers: any,
  totalResults: number,
  csvStringifier: any
) {
  const personSearchUrl = 'https://app.zoominfo.com/profiles/graphql/personSearch';
  const viewContactsUrl = 'https://app.zoominfo.com/anura/userData/viewContacts';

  let personIds: string[] = [];
  let socialUrlsMap: Record<string, any> = {};
  let resultsCollected = 0;
  let page = 1;

  const totalPersonSearchCalls = Math.ceil(totalResults / 25);
  const totalApiCalls = totalPersonSearchCalls + totalResults; // PersonSearch calls + viewContacts calls
  let apiCallsCompleted = 0;

  // Step 1: Fetch person IDs
  while (isScraping && personIds.length < totalResults) {
    if (isPaused) {
      await new Promise((resolve) => {
        const interval = setInterval(() => {
          if (!isPaused) {
            clearInterval(interval);
            resolve(true);
          }
        }, 1000);
      });
    }

    if (!isScraping) {
      break;
    }

    // Update payload with current page
    const updatedPayload = JSON.parse(JSON.stringify(payload)); // Deep copy
    setPageInPayload(updatedPayload, page);

    try {
      const response = await axios.post(personSearchUrl, updatedPayload, { headers });
      const data = response.data;

      const results = data?.data?.personSearch?.data || [];

      if (!results || results.length === 0) {
        if (personIds.length === 0) {
          mainWindow?.webContents.send('error', 'No data found for the given payload.');
        }
        break;
      }

      for (const person of results) {
        if (personIds.length >= totalResults) {
          break;
        }
        const personId = person.personID;
        if (personId) {
          personIds.push(personId);

          // Store social URLs
          socialUrlsMap[personId] = person.socialUrlsParsed || {};
        }
      }

      apiCallsCompleted += 1;
      const progressPercentage = Math.min(
        (apiCallsCompleted / totalApiCalls) * 100,
        100
      );
      mainWindow?.webContents.send('progress-update', {
        progressPercentage,
      });

      page += 1;

      if (personIds.length >= totalResults || !isScraping) {
        break;
      }

      // Delay between requests (simulate human behavior)
      const delay = randomDelay(5000, 15000);
      await cancellableDelay(delay);
      if (!isScraping) {
        break;
      }
    } catch (error: any) {
      console.log('Error in person search:', error);
      if (error.response && [401, 403].includes(error.response.status)) {
        mainWindow?.webContents.send('request-new-cookies');
        await waitForCookiesUpdate();
        continue;
      } else {
        mainWindow?.webContents.send('error', `Error: ${error.message}`);
        break;
      }
    }
  }


  // Step 2: Fetch detailed contact info using viewContacts API
  for (const personId of personIds) {
    if (!isScraping || resultsCollected >= totalResults) {
      console.log('Scraping stopped or all results collected.');
      break;
    }

    const viewContactsPayload = {
      contacts: [
        {
          personId: personId.toString(),
        },
      ],
      creditSource: 'GROW',
    };


    try {
      const response = await axios.post(viewContactsUrl, viewContactsPayload, {
        headers,
        timeout: 30000,
      });
      const data = response.data;


      const contacts = data?.data || [];

      if (!contacts || contacts.length === 0) {
        console.log(`No contact data found for personId ${personId}`);
        continue;
      }

      for (const contact of contacts) {
        // Add social URLs
        const socialUrls = socialUrlsMap[personId] || {};
        contact.LinkedIn = socialUrls.linkedin || '';
        contact.Facebook = socialUrls.facebook || '';
        contact.Twitter = socialUrls.twitter || '';
        contact.Instagram = socialUrls.instagram || '';

        const csvRow = transformResultToCsvRow('Contact Search', contact);
        csvStringifier.write(csvRow);
        resultsCollected += 1;

        if (!isScraping || resultsCollected >= totalResults) {
          break;
        }
      }

      apiCallsCompleted += 1;
      const progressPercentage = Math.min(
        (apiCallsCompleted / totalApiCalls) * 100,
        100
      );
      mainWindow?.webContents.send('progress-update', {
        progressPercentage,
      });

      if (!isScraping || resultsCollected >= totalResults) {
        break;
      }

      // Delay between requests (simulate human behavior)
      const delay = randomDelay(5000, 15000);
      await cancellableDelay(delay);

      // Check if scraping is paused after the delay
      await checkPaused();

      if (!isScraping) {
        break;
      }
    } catch (error: any) {
      console.log('Error fetching viewContacts:', error);
      if (error.response && [401, 403].includes(error.response.status)) {
        mainWindow?.webContents.send('request-new-cookies');
        await waitForCookiesUpdate();
        continue;
      } else {
        mainWindow?.webContents.send('error', `Error: ${error.message}`);
        break;
      }
    }
  }
}

async function checkPaused() {
  if (isPaused) {
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (!isPaused) {
          clearInterval(interval);
          resolve(true);
        }
      }, 1000);
    });
  }
}

function cancellableDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      delayCancel = null;
      resolve();
    }, ms);
    delayCancel = () => {
      clearTimeout(timeout);
      delayCancel = null;
      resolve(); // Proceed immediately
    };
  });
}

function extractHeadersFromCookies(cookies: any[]): Record<string, string> {
  const cookieDict: Record<string, string> = {};
  for (const cookie of cookies) {
    cookieDict[cookie.name] = cookie.value;
  }

  const userId = cookieDict.userId;
  const ziaccesstoken = cookieDict.ziaccesstoken;
  const ziidRaw = cookieDict.ziid || '';
  const zisessionRaw = cookieDict.zisession || '';

  // Decode and clean ziid and zisession
  const ziid = decodeURIComponent(ziidRaw).replace(/^"|"$/g, '');
  const zisession = decodeURIComponent(zisessionRaw).replace(/^"|"$/g, '');


  if (!userId || !ziaccesstoken || !ziid || !zisession) {
    throw new Error('Missing required cookies.');
  }

  const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

  return {
    "authority": "app.zoominfo.com",
    "method": "POST",
    "scheme": "https",
    "accept": "application/json, text/plain, */*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "en-US,en;q=0.9",
    "apollographql-client-name": "AiEmailPersonClient",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "origin": "https://app.zoominfo.com",
    "pragma": "no-cache",
    "referer": "https://app.zoominfo.com/",
    "sec-ch-ua": '"Not)A;Brand";v="99", "Google Chrome";v="127", "Chromium";v="127"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "session-token": "1",
    "user": userId,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "x-requested-with": "XMLHttpRequest",
    "x-sourceid": "ZI_FOR_SALES",
    "x-ziaccesstoken": ziaccesstoken,
    "x-ziid": ziid,
    "x-zisession": zisession,
    "Cookie": cookieHeader,
  };
}

function getApiUrl(apiType: string): string {
  switch (apiType) {
    case 'Company Search':
      return 'https://app.zoominfo.com/profiles/graphql/companySearch';
    case 'Person Search':
      return 'https://app.zoominfo.com/profiles/graphql/personSearch';
    case 'Scoops Search':
      return 'https://app.zoominfo.com/profiles/graphql/scoopsAdvancedSearch';
    default:
      throw new Error('Unknown API type.');
  }
}

function extractResults(apiType: string, data: any): any[] {
  // Extract results based on API type
  switch (apiType) {
    case 'Company Search':
      return data?.data?.companySearch?.data || [];
    case 'Person Search':
      return data?.data?.personSearch?.data || [];
    case 'Scoops Search':
      return data?.data?.scoopsAdvancedSearch?.data || [];
    default:
      return [];
  }
}

function transformResultToCsvRow(apiType: string, result: any): Record<string, any> {
  // Transform result object into CSV row based on API type
  switch (apiType) {
    case 'Company Search': {
      const location = result.location || {};
      const topLevelIndustry = result.topLevelIndustry || [];
      return {
        'Company ID': result.companyID || '',
        'Company Name': result.companyName || '',
        'Company Domain': result.companyDomain || '',
        'Company Type': result.companyType || '',
        'Company Phone': result.companyPhone || '',
        'Revenue': result.revenue || '',
        'Employees': result.employees || '',
        'Top Level Industry 0': topLevelIndustry[0] || '',
        'Top Level Industry 1': topLevelIndustry[1] || '',
        'Website': result.website || '',
        'Company Description': result.companyDescription || '',
        'City': location.City || '',
        'Country Code': location.CountryCode || '',
        'State': location.State || '',
        'Street': location.Street || '',
        'Zip': location.Zip || '',
      };
    }
    case 'Person Search': {
      const socialUrlsParsed = result.socialUrlsParsed || {};
      const location = result.location || {};
      const employmentHistory = result.employmentHistory || [{}];
      const employmentHistory0 = employmentHistory[0] || {};
      return {
        'First Name': result.firstName || '',
        'Last Name': result.lastName || '',
        'Job Title': result.jobTitle || '',
        'LinkedIn': socialUrlsParsed.linkedin || '',
        'Facebook': socialUrlsParsed.facebook || '',
        'Twitter': socialUrlsParsed.twitter || '',
        'Instagram': socialUrlsParsed.instagram || '',
        'Metro Area': location.metroArea || '',
        'City': location.City || '',
        'State': location.State || '',
        'Street': location.Street || '',
        'Zip': location.Zip || '',
        'Country Code': location.CountryCode || '',
        'Company Domain': result.companyDomain || '',
        'Company Name': result.companyName || '',
        'Company Phone': result.companyPhone || '',
        'Company Revenue': result.companyRevenue || '',
        'Company Website 0': employmentHistory0.companyWebsite || '',
        'Company Description': result.companyDescription || '',
      };
    }
    case 'Contact Search': {
      const companyAddress = result.companyAddress || {};
      const location = result.location || {};
      const topLevelIndustry = result.topLevelIndustry || [];
      return {
        'Person ID': result.personID || '',
        'First Name': result.firstName || '',
        'Middle Initial': result.middleInitial || '',
        'Last Name': result.lastName || '',
        'Company': result.title || '',
        'Job Title': result.jobTitle || '',
        'Person Phone': result.phone || '',
        'Business Email': result.personalEmail || '',
        'Person Email': result.email || '',
        'LinkedIn': result.LinkedIn || '',
        'Facebook': result.Facebook || '',
        'Twitter': result.Twitter || '',
        'Instagram': result.Instagram || '',
        'Person Street': location.Street || '',
        'Person City': location.City || '',
        'Person State': location.State || '',
        'Person Zip': location.Zip || '',
        'Person Country': location.CountryCode || '',
        'Person Metro Area': location.metroArea || '',
        'Company ID': result.companyID || '',
        'Company Name': result.companyName || '',
        'Company Revenue': result.companyRevenue || '',
        'Company Employees': result.companyEmployees || '',
        'Company Domain': result.companyDomain || '',
        'Company Website': result.website || '',
        'Company Description': result.companyDescription || '',
        'Company Phone': result.companyPhone || '',
        'Company Ticker': result.companyTicker || '',
        'Top Level Industry': topLevelIndustry[0] || '',
        'Company Type': result.companyType || '',
        'Company Street': companyAddress.Street || '',
        'Company City': companyAddress.City || '',
        'Company State': companyAddress.State || '',
        'Company Zip': companyAddress.Zip || '',
        'Company Country': companyAddress.CountryCode || '',
        'Confidence Score': result.confidenceScore || '',
      };
    }
    case 'Scoops Search': {
      const companyRecord = result.companyRecord || {};
      const scoopTypes = result.scoopTypes?.scoopType || [];
      const scoopTopics = result.scoopTopics?.scoopTopic || [];

      // Map scoop types and topics
      const scoopTypeMapping: { [key: string]: string } = {
        '11': 'Open Position',
        '21': 'Project',
        '20': 'Painpoint',
        '4': 'Mergers & Acquisitions',
        '9': 'Product Launch',
      };
      const scoopTopicMapping: { [key: string]: string } = {
        '50': 'Application Development',
        '115': 'Enterprise Architecture',
        '226': 'Artificial Intelligence',
        '61': 'Product Development',
        '41': 'Spending/Investment',
        '105': 'Contingent Workforce',
        '116': 'Financial Planning',
        '54': 'Request for Proposal',
      };
      const scoopTypeNames = scoopTypes
        .map((type: string) => scoopTypeMapping[type.toString()] || 'Unknown')
        .join(', ');
      const scoopTopicNames = scoopTopics
        .map((topic: string) => scoopTopicMapping[topic.toString()] || 'Unknown')
        .join(', ');

      return {
        'Published Date': result.publishedDate || '',
        'Company ID': companyRecord.companyID || '',
        'Company Name': companyRecord.companyName || '',
        'Company Domain': companyRecord.companyDomain || '',
        'Website': companyRecord.website || '',
        'Description': result.description || '',
        'Scoop ID': result.scoopId || '',
        'Scoop Type': scoopTypeNames || '',
        'Scoop Topic': scoopTopicNames || '',
      };
    }
    default:
      return {};
  }
}

function setPageInPayload(payload: any, page: number) {
  if (typeof payload === 'object') {
    for (const key in payload) {
      if (key.toLowerCase() === 'page') {
        payload[key] = page;
      } else {
        setPageInPayload(payload[key], page);
      }
    }
  }
}

async function waitForCookiesUpdate() {
  return new Promise((resolve) => {
    ipcMain.once('update-cookies', (_event, newCookies) => {
      if (scrapeData) {
        scrapeData.cookies = newCookies;
        scrapeData.headers = extractHeadersFromCookies(newCookies);
      }
      resolve(true);
    });
  });
}

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
