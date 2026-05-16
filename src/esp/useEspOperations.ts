'use client';

import { useState } from 'react';
import {
  getCommunityFirmware,
  getOfficialFirmware,
} from '@/remote/firmwareFetcher';
import { downloadData } from '@/utils/download';
import { wrapWithWakeLock } from '@/utils/wakelock';
import {
  identifyFirmware,
  isIdentificationSuccessful,
  type FirmwareInfo,
} from '@/utils/firmwareIdentifier';
import OtaPartition, { OtaPartitionDetails } from './OtaPartition';
import useStepRunner from './useStepRunner';
import EspController, {
  X3_PARTITION_LAYOUT,
  X4_PARTITION_LAYOUT,
} from './EspController';

const x4PartitionTable = [
  { type: 'data-nvs', offset: 0x9000, size: 0x5000 },
  { type: 'data-ota', offset: 0xe000, size: 0x2000 },
  { type: 'app-ota_0', offset: 0x10000, size: 0x640000 },
  { type: 'app-ota_1', offset: 0x650000, size: 0x640000 },
  { type: 'data-spiffs', offset: 0xc90000, size: 0x360000 },
  { type: 'data-coredump', offset: 0xff0000, size: 0x10000 },
];

const x3PartitionTable = [
  { type: 'data-nvs', offset: 0x9000, size: 0x5000 },
  { type: 'data-ota', offset: 0xe000, size: 0x2000 },
  { type: 'app-ota_0', offset: 0x10000, size: 0x770000 },
  { type: 'app-ota_1', offset: 0x780000, size: 0x770000 },
  { type: 'data-spiffs', offset: 0xef0000, size: 0x100000 },
  { type: 'data-coredump', offset: 0xff0000, size: 0x10000 },
];

interface PartitionEntry {
  type: string;
  offset: number;
  size: number;
}

function matchesPartitionTable(
  actual: PartitionEntry[],
  expected: PartitionEntry[],
) {
  return (
    actual.length === expected.length &&
    expected.every(
      (exp, i) =>
        actual[i]!.type === exp.type &&
        actual[i]!.offset === exp.offset &&
        actual[i]!.size === exp.size,
    )
  );
}

export type DeviceModel = 'x4' | 'x3';

export function useEspOperations() {
  const { stepData, initializeSteps, updateStepData, runStep } =
    useStepRunner();
  const [isRunning, setIsRunning] = useState(false);
  const [deviceModel, setDeviceModel] = useState<DeviceModel>('x4');

  const resetStepName = 'Reset device';
  const softResetStepName = 'Disconnect (unplug and replug USB to restart)';

  const validateAndDetectPartitionLayout = async (
    espController: EspController,
  ) => {
    const partitionTable = await espController.readPartitionTable();

    const validTables =
      deviceModel === 'x3'
        ? [x3PartitionTable, x4PartitionTable]
        : [x4PartitionTable];

    const matched = validTables.find((t) =>
      matchesPartitionTable(partitionTable, t),
    );

    if (!matched) {
      throw new Error(
        `Unexpected partition configuration for ${deviceModel.toUpperCase()}. Make sure you've selected the correct device model.\nGot ${JSON.stringify(
          partitionTable,
          null,
          2,
        )}`,
      );
    }

    espController.setPartitionLayout(
      matchesPartitionTable(partitionTable, x3PartitionTable)
        ? X3_PARTITION_LAYOUT
        : X4_PARTITION_LAYOUT,
    );
  };

  const wrapWithRunning =
    <Args extends unknown[], T>(fn: (...a: Args) => Promise<T>) =>
    async (...a: Args) => {
      setIsRunning(true);
      return fn(...a).finally(() => setIsRunning(false));
    };

  const flashRemoteFirmware = async (
    getFirmware: () => Promise<Uint8Array>,
    { skipReset = false }: { skipReset?: boolean } = {},
  ) => {
    const stepName = skipReset ? softResetStepName : resetStepName;
    initializeSteps([
      'Connect to device',
      'Validate partition table',
      'Download firmware',
      'Read otadata partition',
      'Flash app partition',
      'Flash otadata partition',
      stepName,
    ]);

    const espController = await runStep('Connect to device', async () => {
      const c = await EspController.fromRequestedDevice(
        deviceModel === 'x3' ? X3_PARTITION_LAYOUT : X4_PARTITION_LAYOUT,
      );
      await c.connect();
      return c;
    });

    await runStep('Validate partition table', () =>
      validateAndDetectPartitionLayout(espController),
    );

    const firmwareFile = await runStep('Download firmware', getFirmware);

    const [otaPartition, backupPartitionLabel] = await runStep(
      'Read otadata partition',
      async (): Promise<
        [OtaPartition, OtaPartitionDetails['partitionLabel']]
      > => {
        const partition = await espController.readOtadataPartition((_, p, t) =>
          updateStepData('Read otadata partition', {
            progress: { current: p, total: t },
          }),
        );

        return [partition, partition.getCurrentBackupPartitionLabel()];
      },
    );

    const flashAppPartitionStepName = `Flash app partition (${backupPartitionLabel})`;
    updateStepData('Flash app partition', { name: flashAppPartitionStepName });
    await runStep(flashAppPartitionStepName, () =>
      espController.writeAppPartition(
        backupPartitionLabel,
        firmwareFile,
        (_, p, t) =>
          updateStepData(flashAppPartitionStepName, {
            progress: { current: p, total: t },
          }),
      ),
    );

    await runStep('Flash otadata partition', async () => {
      otaPartition.setBootPartition(backupPartitionLabel);

      await espController.writeOtadataPartition(otaPartition, (_, p, t) =>
        updateStepData('Flash otadata partition', {
          progress: { current: p, total: t },
        }),
      );
    });

    await runStep(stepName, () => espController.disconnect({ skipReset }));
  };

  const flashEnglishFirmware = async () =>
    flashRemoteFirmware(() => getOfficialFirmware('en', deviceModel));
  const flashChineseFirmware = async () =>
    flashRemoteFirmware(() => getOfficialFirmware('ch', deviceModel));
  const flashCrossPointFirmware = async () =>
    flashRemoteFirmware(() => getCommunityFirmware('CrossPoint'), {
      skipReset: deviceModel === 'x3',
    });

  const flashCustomFirmware = async (getFile: () => File | undefined) => {
    initializeSteps([
      'Read file',
      'Connect to device',
      'Validate partition table',
      'Read otadata partition',
      'Flash app partition',
      'Flash otadata partition',
      resetStepName,
    ]);

    const fileData = await runStep('Read file', async () => {
      const file = getFile();
      if (!file) {
        throw new Error('File not found');
      }
      return new Uint8Array(await file.arrayBuffer());
    });

    const espController = await runStep('Connect to device', async () => {
      const c = await EspController.fromRequestedDevice(
        deviceModel === 'x3' ? X3_PARTITION_LAYOUT : X4_PARTITION_LAYOUT,
      );
      await c.connect();
      return c;
    });

    await runStep('Validate partition table', () =>
      validateAndDetectPartitionLayout(espController),
    );

    const [otaPartition, backupPartitionLabel] = await runStep(
      'Read otadata partition',
      async (): Promise<
        [OtaPartition, OtaPartitionDetails['partitionLabel']]
      > => {
        const partition = await espController.readOtadataPartition((_, p, t) =>
          updateStepData('Read otadata partition', {
            progress: { current: p, total: t },
          }),
        );

        return [partition, partition.getCurrentBackupPartitionLabel()];
      },
    );

    const flashAppPartitionStepName = `Flash app partition (${backupPartitionLabel})`;
    updateStepData('Flash app partition', { name: flashAppPartitionStepName });
    await runStep(flashAppPartitionStepName, () =>
      espController.writeAppPartition(
        backupPartitionLabel,
        fileData,
        (_, p, t) =>
          updateStepData(flashAppPartitionStepName, {
            progress: { current: p, total: t },
          }),
      ),
    );

    await runStep('Flash otadata partition', async () => {
      otaPartition.setBootPartition(backupPartitionLabel);

      await espController.writeOtadataPartition(otaPartition, (_, p, t) =>
        updateStepData('Flash otadata partition', {
          progress: { current: p, total: t },
        }),
      );
    });

    await runStep(resetStepName, () => espController.disconnect());
  };

  const saveFullFlash = async () => {
    initializeSteps([
      'Connect to device',
      'Read flash',
      'Disconnect from device',
    ]);

    const espController = await runStep('Connect to device', async () => {
      const c = await EspController.fromRequestedDevice(
        deviceModel === 'x3' ? X3_PARTITION_LAYOUT : X4_PARTITION_LAYOUT,
      );
      await c.connect();
      return c;
    });

    const firmwareFile = await runStep(
      'Read flash',
      wrapWithWakeLock(() =>
        espController.readFullFlash((_, p, t) =>
          updateStepData('Read flash', { progress: { current: p, total: t } }),
        ),
      ),
    );

    await runStep('Disconnect from device', () =>
      espController.disconnect({ skipReset: true }),
    );

    downloadData(firmwareFile, 'flash.bin', 'application/octet-stream');
  };

  const writeFullFlash = async (getFile: () => File | undefined) => {
    initializeSteps([
      'Read file',
      'Connect to device',
      'Write flash',
      resetStepName,
    ]);

    const fileData = await runStep('Read file', async () => {
      const file = getFile();
      if (!file) {
        throw new Error('File not found');
      }
      return new Uint8Array(await file.arrayBuffer());
    });

    const espController = await runStep('Connect to device', async () => {
      const c = await EspController.fromRequestedDevice(
        deviceModel === 'x3' ? X3_PARTITION_LAYOUT : X4_PARTITION_LAYOUT,
      );
      await c.connect();
      return c;
    });

    await runStep('Write flash', () =>
      espController.writeFullFlash(fileData, (_, p, t) =>
        updateStepData('Write flash', { progress: { current: p, total: t } }),
      ),
    );

    await runStep(resetStepName, () => espController.disconnect());
  };

  const readDebugOtadata = async () => {
    initializeSteps([
      'Connect to device',
      'Read otadata partition',
      'Disconnect from device',
    ]);

    const espController = await runStep('Connect to device', async () => {
      const c = await EspController.fromRequestedDevice(
        deviceModel === 'x3' ? X3_PARTITION_LAYOUT : X4_PARTITION_LAYOUT,
      );
      await c.connect();
      return c;
    });

    const otaPartition = await runStep('Read otadata partition', () =>
      espController.readOtadataPartition((_, p, t) =>
        updateStepData('Read otadata partition', {
          progress: { current: p, total: t },
        }),
      ),
    );

    await runStep('Disconnect from device', () =>
      espController.disconnect({ skipReset: true }),
    );

    return otaPartition;
  };

  const readAppPartition = async (partitionLabel: 'app0' | 'app1') => {
    initializeSteps([
      'Connect to device',
      'Validate partition table',
      `Read app partition (${partitionLabel})`,
      'Disconnect from device',
    ]);

    const espController = await runStep('Connect to device', async () => {
      const c = await EspController.fromRequestedDevice(
        deviceModel === 'x3' ? X3_PARTITION_LAYOUT : X4_PARTITION_LAYOUT,
      );
      await c.connect();
      return c;
    });

    await runStep('Validate partition table', () =>
      validateAndDetectPartitionLayout(espController),
    );

    const data = await runStep(`Read app partition (${partitionLabel})`, () =>
      espController.readAppPartition(partitionLabel, (_, p, t) =>
        updateStepData(`Read app partition (${partitionLabel})`, {
          progress: { current: p, total: t },
        }),
      ),
    );

    await runStep('Disconnect from device', () =>
      espController.disconnect({ skipReset: true }),
    );

    return data;
  };

  const swapBootPartition = async () => {
    initializeSteps([
      'Connect to device',
      'Read otadata partition',
      'Flash otadata partition',
      resetStepName,
    ]);

    const espController = await runStep('Connect to device', async () => {
      const c = await EspController.fromRequestedDevice(
        deviceModel === 'x3' ? X3_PARTITION_LAYOUT : X4_PARTITION_LAYOUT,
      );
      await c.connect();
      return c;
    });

    const [otaPartition, backupPartitionLabel] = await runStep(
      'Read otadata partition',
      async (): Promise<
        [OtaPartition, OtaPartitionDetails['partitionLabel']]
      > => {
        const partition = await espController.readOtadataPartition((_, p, t) =>
          updateStepData('Read otadata partition', {
            progress: { current: p, total: t },
          }),
        );

        return [partition, partition.getCurrentBackupPartitionLabel()];
      },
    );

    otaPartition.setBootPartition(backupPartitionLabel);
    await runStep('Flash otadata partition', () =>
      espController.writeOtadataPartition(otaPartition, (_, p, t) =>
        updateStepData('Flash otadata partition', {
          progress: { current: p, total: t },
        }),
      ),
    );

    await runStep(resetStepName, () => espController.disconnect());

    return otaPartition;
  };

  const fakeWriteFullFlash = async () => {
    initializeSteps([
      'Read file',
      'Connect to device',
      'Write flash',
      resetStepName,
    ]);

    await runStep(
      'Read file',
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, 100);
        }),
    );

    await runStep(
      'Connect to device',
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, 500);
        }),
    );

    await runStep(
      'Write flash',
      () =>
        new Promise((resolve, reject) => {
          let value = 0;
          const interval = setInterval(() => {
            if (value > 1) {
              clearInterval(interval);
              resolve(undefined);
              return;
            }

            if (value > 0.2) {
              clearInterval(interval);
              reject(new Error('Whoops, failed!'));
              return;
            }

            value += 0.001;
            updateStepData('Write flash', {
              progress: { current: value * 1000000, total: 1000000 },
            });
          }, 20);
        }),
    );

    await runStep(
      resetStepName,
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, 500);
        }),
    );
  };

  const readAndIdentifyAllFirmware = async (): Promise<{
    app0: FirmwareInfo;
    app1: FirmwareInfo;
    currentBoot: 'app0' | 'app1';
  }> => {
    initializeSteps([
      'Connect to device',
      'Validate partition table',
      'Read otadata partition',
      'Read app0 partition',
      'Read app1 partition',
      'Identify firmware types',
      'Disconnect from device',
    ]);

    const espController = await runStep('Connect to device', async () => {
      const c = await EspController.fromRequestedDevice(
        deviceModel === 'x3' ? X3_PARTITION_LAYOUT : X4_PARTITION_LAYOUT,
      );
      await c.connect();
      return c;
    });

    await runStep('Validate partition table', () =>
      validateAndDetectPartitionLayout(espController),
    );

    const otaPartition = await runStep('Read otadata partition', () =>
      espController.readOtadataPartition((_, p, t) =>
        updateStepData('Read otadata partition', {
          progress: { current: p, total: t },
        }),
      ),
    );

    const currentBoot = otaPartition.getCurrentBootPartitionLabel();

    const readAndIdentifyInChunks = async (partitionLabel: 'app0' | 'app1') => {
      const chunkSize = 0x6400; // 25KB
      const maxReadSize = 0x20000; // 128KB
      let readData = new Uint8Array();
      let info: FirmwareInfo | undefined;

      for (let offset = 0; offset < maxReadSize; offset += chunkSize) {
        // eslint-disable-next-line no-await-in-loop
        const chunk = await espController.readAppPartitionForIdentification(
          partitionLabel,
          {
            readSize: chunkSize,
            offset,
            onPacketReceived: (_, p, t) =>
              updateStepData(`Read ${partitionLabel} partition`, {
                // Show cumulative progress: offset + current chunk progress
                // Total shows the end of current chunk range
                progress: { current: offset + p, total: offset + t },
              }),
          },
        );

        const newData = new Uint8Array(readData.length + chunk.length);
        newData.set(readData);
        newData.set(chunk, readData.length);
        readData = newData;

        info = identifyFirmware(readData);
        if (isIdentificationSuccessful(info)) {
          return info;
        }
      }

      return (
        info ?? {
          type: 'unknown',
          version: 'unknown',
          displayName: 'Custom/Unknown Firmware',
        }
      ); // Return the last identification result if not found
    };

    const app0Info = await runStep('Read app0 partition', () =>
      readAndIdentifyInChunks('app0'),
    );

    const app1Info = await runStep('Read app1 partition', () =>
      readAndIdentifyInChunks('app1'),
    );

    await runStep('Identify firmware types', async () => {
      // This step is now just for display - identification already happened during read
    });

    await runStep('Disconnect from device', () =>
      espController.disconnect({ skipReset: true }),
    );

    return {
      app0: app0Info,
      app1: app1Info,
      currentBoot,
    };
  };

  return {
    stepData,
    isRunning,
    deviceModel,
    setDeviceModel,
    actions: {
      flashEnglishFirmware: wrapWithRunning(flashEnglishFirmware),
      flashChineseFirmware: wrapWithRunning(flashChineseFirmware),
      flashCrossPointFirmware: wrapWithRunning(flashCrossPointFirmware),
      flashCustomFirmware: wrapWithRunning(flashCustomFirmware),
      saveFullFlash: wrapWithRunning(saveFullFlash),
      writeFullFlash: wrapWithRunning(writeFullFlash),
      fakeWriteFullFlash: wrapWithRunning(fakeWriteFullFlash),
    },
    debugActions: {
      readDebugOtadata: wrapWithRunning(readDebugOtadata),
      readAppPartition: wrapWithRunning(readAppPartition),
      swapBootPartition: wrapWithRunning(swapBootPartition),
      readAndIdentifyAllFirmware: wrapWithRunning(readAndIdentifyAllFirmware),
    },
  };
}
