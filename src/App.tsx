// src/App.tsx

import React, { useState, useEffect } from 'react';
import { ScrapeData, ProgressUpdate } from '../electron/preload';
import { Dialog } from '@material-tailwind/react';
import { Button } from '@material-tailwind/react';
import { Select, Option } from '@material-tailwind/react';
import { Textarea } from '@material-tailwind/react';
import { Input } from '@material-tailwind/react';
import { Progress } from '@material-tailwind/react';
import { clsx } from 'clsx';
import './App.css';

declare global {
  interface Window {
    electronAPI: any;
  }
}

function App() {
  const [apiType, setApiType] = useState<string>('Company Search');
  const [cookiesText, setCookiesText] = useState<string>('');
  const [payloadText, setPayloadText] = useState<string>('');
  const [resultsCount, setResultsCount] = useState<string>('25');
  const [savePath, setSavePath] = useState<string>('');
  const [progress, setProgress] = useState<number>(0);
  const [isScraping, setIsScraping] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [canStart, setCanStart] = useState<boolean>(false);
  const [modalVisible, setModalVisible] = useState<boolean>(false);
  const [modalTitle, setModalTitle] = useState<string>('');
  const [modalMessage, setModalMessage] = useState<string>('');
  const [modalType, setModalType] = useState<'success' | 'error' | 'info'>('info');

  const [startIndex, setStartIndex] = useState<string>('0');

  useEffect(() => {
    setCanStart(
      cookiesText.trim() !== '' &&
      payloadText.trim() !== '' &&
      savePath.trim() !== '' &&
      resultsCount.trim() !== '' &&
      startIndex.trim() !== ''
    );
  }, [cookiesText, payloadText, savePath, resultsCount, startIndex]);

  useEffect(() => {
    const handleProgressUpdate = (data: ProgressUpdate) => {
      setProgress(data.progressPercentage);
    };

    const handleScrapingFinished = () => {
      setIsScraping(false);
      setIsPaused(false);
      showModal('Success', 'Scraping completed successfully.', 'success');
    };

    const handleScrapingStopped = () => {
      setIsScraping(false);
      setIsPaused(false);
      showModal('Scraping Stopped', 'Scraping has been stopped by the user.', 'info');
    };

    const handleError = (error: string) => {
      setIsScraping(false);
      setIsPaused(false);
      showModal('Error', error, 'error');
    };

    const handleRequestNewCookies = () => {
      const newCookies = prompt(
        'Cookies have expired. Please enter new cookies (JSON format):',
        cookiesText
      );
      if (newCookies) {
        try {
          const parsedCookies = JSON.parse(newCookies);
          setCookiesText(newCookies);
          window.electronAPI.updateCookies(parsedCookies);
        } catch (e) {
          showModal('Error', 'Invalid JSON format for cookies.', 'error');
        }
      } else {
        showModal('Error', 'No new cookies provided. Scraping will stop.', 'error');
        window.electronAPI.stopScraping();
      }
    };

    const handleAutoPause = () => {
      setIsPaused(true);
      showModal('Auto-Pause', 'The system has paused scraping due to sleep mode.', 'info');
    };
  
    const handleAutoResume = () => {
      setIsPaused(false);
      showModal('Auto-Resume', 'Scraping has resumed as the system woke up.', 'info');
    };

    window.electronAPI.onProgressUpdate(handleProgressUpdate);
    window.electronAPI.onScrapingFinished(handleScrapingFinished);
    window.electronAPI.onScrapingStopped(handleScrapingStopped);
    window.electronAPI.onError(handleError);
    window.electronAPI.onRequestNewCookies(handleRequestNewCookies);

    window.electronAPI.onAutoPause(handleAutoPause);
    window.electronAPI.onAutoResume(handleAutoResume);


    return () => {
      // Clean up event listeners if necessary
    };
  }, []);

  const showModal = (
    title: string,
    message: string,
    type: 'success' | 'error' | 'info'
  ) => {
    setModalTitle(title);
    setModalMessage(message);
    setModalType(type);
    setModalVisible(true);
  };

  const closeModal = () => {
    setModalVisible(false);
  };

  const handleStart = () => {
    if (isScraping) {
      window.electronAPI.stopScraping();
      setIsScraping(false);
      setIsPaused(false);
      setProgress(0);
    } else {
      if (!canStart) {
        showModal(
          'Missing Information',
          'Please fill all required fields before starting the scraping.',
          'error'
        );
        return;
      }
      try {
        const cookies = JSON.parse(cookiesText);
        const payload = JSON.parse(payloadText);
        const totalResults = parseInt(resultsCount, 10); // Ensure parsing as number
        const startIdx = parseInt(startIndex, 10); // Ensure parsing as number

        if (isNaN(totalResults) || totalResults <= 0) {
          showModal('Error', 'Please enter a valid number for "Number of Results".', 'error');
          return;
        }

        if (isNaN(startIdx) || startIdx < 0) {
          showModal('Error', 'Please enter a valid start index.', 'error');
          return;
        }

        const scrapeData: ScrapeData = {
          apiType,
          cookies,
          payload,
          totalResults,
          startIdx,
          savePath,
          headers: {}
        };

        window.electronAPI.startScraping(scrapeData);
        setIsScraping(true);
        setProgress(0);
      } catch (e: any) {
        showModal('Error', `Error: ${e.message}`, 'error');
      }
    }
  };


  const handlePauseResume = () => {
    if (isPaused) {
      window.electronAPI.resumeScraping();
      setIsPaused(false);
    } else {
      window.electronAPI.pauseScraping();
      setIsPaused(true);
    }
  };

  const handleSelectSaveLocation = async () => {
    const filePath = await window.electronAPI.selectSavePath();
    if (filePath) {
      setSavePath(filePath);
    }
  };

  const handleOpenFile = async () => {
    if (savePath) {
      const exists = await window.electronAPI.fileExists(savePath);
      if (exists) {
        window.electronAPI.openFile(savePath);
      } else {
        showModal('File Not Found', 'The CSV file does not exist yet.', 'error');
      }
    }
  };

  const apiOptions = [
    'Company Search',
    'Person Search',
    'Contact Search',
    'Scoops Search',
  ];

  const handleClearCookies = () => setCookiesText('');
  const handleClearPayload = () => setPayloadText('');
  
  return (
    <div className="min-h-screen w-full bg-gray-50 items-center p-6">
      <h1 className="text-2xl font-bold mb-8 text-center">
        ZoomInfo Data Scraper
      </h1>

      <div className="grid grid-cols-1 gap-6">
        {/* API Selection */}
        <div>
          <label className="block text-md font-medium mb-2">
            Select API
          </label>
          <Select
            value={apiType}
            onChange={(e) => setApiType(e || 'Company Search')}
            className="w-full"
            nonce=""
            onResize={() => { }}
            onResizeCapture={() => { }}
          >
            {apiOptions.map((option) => (
              <Option key={option} value={option}>
                {option}
              </Option>
            ))}
          </Select>
        </div>

        {/* Cookies Textarea with Clear Button */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-md font-medium">Paste Cookies (JSON Format)</label>
            <Button onClick={handleClearCookies} size="sm" color="red">
              Clear
            </Button>
          </div>
          <Textarea
            value={cookiesText}
            onChange={(e) => setCookiesText(e.target.value)}
            placeholder='e.g., [{"name": "userId", "value": "12345"}, ...]'
            className="w-full"
            rows={6}
            nonce=""
            onResize={() => {}}
            onResizeCapture={() => {}}
          />
        </div>

        {/* Payload Textarea with Clear Button */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-md font-medium">Paste Payload (JSON Format)</label>
            <Button onClick={handleClearPayload} size="sm" color="red">
              Clear
            </Button>
          </div>
          <Textarea
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            placeholder="Paste your JSON payload here..."
            className="w-full focus:outline-none"
            rows={6}
          />
        </div>

        {/* Number of Results */}
        <div>
          <label className="block text-md font-medium mb-2">
            Number of Results
          </label>
          <Input
            type="number"
            min="1"
            value={resultsCount}
            onChange={(e) => setResultsCount(e.target.value)}
            className="w-full"
            nonce=""
            onResize={() => { }}
            onResizeCapture={() => { }}
          />
        </div>

        {/* Start Index */}
        <div>
          <label className="block text-md font-medium mb-2">Start Index</label>
          <Input
            type="number"
            min="0"
            value={startIndex}
            onChange={(e) => setStartIndex(e.target.value)} // Fallback to '0' if empty
            className="w-full"
            nonce=""
            onResize={() => { }}
            onResizeCapture={() => { }}
          />
        </div>


        {/* Save Location */}
        <div className="flex items-center space-x-4">
          <Button
            onClick={handleSelectSaveLocation}
            color="blue"
            variant="filled"
            className="focus:outline-none"
            nonce=""
            onResize={() => { }}
            onResizeCapture={() => { }}
          >
            Select Save Location for CSV
          </Button>
          <div className="text-gray-600">
            {savePath ? `Save Location: ${savePath}` : 'No location selected'}
          </div>
        </div>

        {/* Progress Bar */}
        {isScraping && (
          <div>
            <label className="block text-md font-medium text-gray-700 mb-2">
              Progress
            </label>
            <Progress
              value={progress}
              className="w-full"
              nonce=""
              onResize={() => { }}
              onResizeCapture={() => { }}
            />
            <div className="text-center mt-2 text-gray-600">
              {progress.toFixed(2)}% completed
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-center space-x-4 mt-6">
          <Button
            onClick={handleStart}
            disabled={!canStart && !isScraping}
            color={isScraping ? 'red' : 'green'}
            variant="filled"
            className={clsx('focus:outline-none', {
              'cursor-not-allowed': !canStart && !isScraping,
            })}
            nonce=""
            onResize={() => { }}
            onResizeCapture={() => { }}
          >
            {isScraping ? 'Stop Scraping' : 'Start Scraping'}
          </Button>
          <Button
            onClick={handlePauseResume}
            disabled={!isScraping}
            color="yellow"
            variant="filled"
            className={clsx('focus:outline-none', {
              'cursor-not-allowed': !isScraping,
            })}
            nonce=""
            onResize={() => { }}
            onResizeCapture={() => { }}
          >
            {isPaused ? 'Resume Scraping' : 'Pause Scraping'}
          </Button>
          <Button
            onClick={handleOpenFile}
            disabled={!savePath}
            color="gray"
            variant="filled"
            className={clsx('focus:outline-none', {
              'cursor-not-allowed': !savePath,
            })}
            nonce=""
            onResize={() => { }}
            onResizeCapture={() => { }}
          >
            Open CSV File
          </Button>
        </div>
      </div>

      {/* Modal */}
      <Dialog
        open={modalVisible}
        handler={closeModal}
        size="sm"
        className="p-6"
        animate={{
          mount: { scale: 1, y: 0 },
          unmount: { scale: 0.9, y: -100 },
        }}
        nonce=""
        onResize={() => { }}
        onResizeCapture={() => { }}
      >
        <Dialog.Header>{modalTitle}</Dialog.Header>
        <Dialog.Body divider>{modalMessage}</Dialog.Body>
        <Dialog.Footer>
          <Button
            color="blue"
            onClick={closeModal}
            nonce=""
            onResize={() => { }}
            onResizeCapture={() => { }}
          >
            OK
          </Button>
        </Dialog.Footer>
      </Dialog>
    </div>
  );
}

export default App;
