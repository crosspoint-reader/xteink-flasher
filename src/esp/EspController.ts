'use client';

import * as crypto from 'crypto';

import { ESPLoader, Transport } from 'esptool-js';
import OtaPartition from '@/esp/OtaPartition';

const PARTITION_TYPES: Record<number, Record<number, string>> = {
  // App type
  0x00: {
    0x00: 'app-factory',
    0x10: 'app-ota_0',
    0x11: 'app-ota_1',
    0x12: 'app-ota_2',
    0x13: 'app-ota_3',
    0x20: 'app-test',
  },
  // Data type
  0x01: {
    0x00: 'data-ota',
    0x01: 'data-phy',
    0x02: 'data-nvs',
    0x03: 'data-coredump',
    0x04: 'data-nvs_keys',
    0x05: 'data-efuse',
    0x06: 'data-undefined',
    0x80: 'data-esphttpd',
    0x81: 'data-fat',
    0x82: 'data-spiffs',
    0x83: 'data-littlefs',
  },
  // Bootloader type
  0x02: {
    0x00: 'bootloader-primary',
    0x01: 'bootloader-ota',
  },
  // Partition table type
  0x03: {
    0x00: 'partitiontable-primary',
    0x01: 'partitiontable-ota',
  },
};

export interface PartitionLayout {
  app0Offset: number;
  app1Offset: number;
  appSize: number;
}

export const X4_PARTITION_LAYOUT: PartitionLayout = {
  app0Offset: 0x10000,
  app1Offset: 0x650000,
  appSize: 0x640000,
};

export const X3_PARTITION_LAYOUT: PartitionLayout = {
  app0Offset: 0x10000,
  app1Offset: 0x780000,
  appSize: 0x770000,
};

export default class EspController {
  static async requestDevice() {
    if (!('serial' in navigator && navigator.serial)) {
      throw new Error(
        'WebSerial is not supported in this browser. Please use Chrome or Edge.',
      );
    }

    return navigator.serial.requestPort({
      filters: [{ usbVendorId: 12346, usbProductId: 4097 }],
    });
  }

  static async fromRequestedDevice(
    partitionLayout: PartitionLayout = X4_PARTITION_LAYOUT,
  ) {
    const device = await this.requestDevice();
    return new EspController(device, partitionLayout);
  }

  private espLoader;

  private layout: PartitionLayout;

  constructor(
    device: SerialPort,
    partitionLayout: PartitionLayout = X4_PARTITION_LAYOUT,
  ) {
    const transport = new Transport(device, false);
    this.layout = partitionLayout;
    this.espLoader = new ESPLoader({
      transport,
      baudrate: 115200,
      romBaudrate: 115200,
      enableTracing: false,
    });
  }

  setPartitionLayout(layout: PartitionLayout) {
    this.layout = layout;
  }

  async connect() {
    await this.espLoader.main();
  }

  async disconnect({ skipReset = false }: { skipReset?: boolean } = {}) {
    await this.espLoader.after(skipReset ? 'no_reset_stub' : 'hard_reset');
    await this.espLoader.transport.disconnect();
  }

  async readPartitionTable() {
    const partitionData = [];

    const data = await this.espLoader.readFlash(0x8000, 0x2000);
    const md5 = crypto.createHash('md5');
    for (let offset = 0; offset < data.length; offset += 32) {
      const chunk = data.slice(offset, offset + 32);
      if (
        chunk.length !== 32 ||
        Buffer.from(chunk).equals(Buffer.alloc(32, 0xff))
      )
        break;
      if (Buffer.from(chunk.slice(0, 2)).equals(Buffer.from([0xeb, 0xeb]))) {
        if (Buffer.from(chunk.slice(16)).equals(md5.digest())) {
          // eslint-disable-next-line no-continue
          continue;
        } else {
          throw new Error("MD5 checksums don't match!");
        }
      }

      md5.update(Buffer.from(chunk));
      partitionData.push({
        type:
          PARTITION_TYPES[chunk[2] ?? 0x99]?.[chunk[3] ?? 0x99] ?? 'unknown',
        /* eslint-disable no-bitwise */
        offset:
          (chunk[4] ?? 0) +
          ((chunk[5] ?? 0) << 8) +
          ((chunk[6] ?? 0) << 16) +
          ((chunk[7] ?? 0) << 24),
        size:
          (chunk[8] ?? 0) +
          ((chunk[9] ?? 0) << 8) +
          ((chunk[10] ?? 0) << 16) +
          ((chunk[11] ?? 0) << 24),
        /* eslint-enable no-bitwise */
      });
    }
    return partitionData;
  }

  async readFullFlash(
    onPacketReceived?: (
      packet: Uint8Array,
      progress: number,
      totalSize: number,
    ) => void,
  ) {
    return this.espLoader.readFlash(0, 0x1000000, onPacketReceived);
  }

  async writeFullFlash(
    data: Uint8Array,
    reportProgress?: (
      fileIndex: number,
      written: number,
      total: number,
    ) => void,
  ) {
    if (data.length !== 0x1000000) {
      throw new Error(
        `Data length must be 0x1000000, but got 0x${data.length.toString().padStart(7, '0')}`,
      );
    }

    await this.writeData(data, 0, reportProgress);
  }

  async readOtadataPartition(
    onPacketReceived?: (
      packet: Uint8Array,
      progress: number,
      totalSize: number,
    ) => void,
  ) {
    return new OtaPartition(
      await this.espLoader.readFlash(0xe000, 0x2000, onPacketReceived),
    );
  }

  async writeOtadataPartition(
    partition: OtaPartition,
    reportProgress?: (
      fileIndex: number,
      written: number,
      total: number,
    ) => void,
  ) {
    await this.writeData(partition.data, 0xe000, reportProgress);
  }

  async readAppPartition(
    partitionLabel: 'app0' | 'app1',
    onPacketReceived?: (
      packet: Uint8Array,
      progress: number,
      totalSize: number,
    ) => void,
  ) {
    const offset =
      partitionLabel === 'app0'
        ? this.layout.app0Offset
        : this.layout.app1Offset;
    return this.espLoader.readFlash(
      offset,
      this.layout.appSize,
      onPacketReceived,
    );
  }

  async readAppPartitionForIdentification(
    partitionLabel: 'app0' | 'app1',
    {
      readSize = 0x6400, // Default to 25KB (0x6400) for fast identification
      offset = 0,
      onPacketReceived,
    }: {
      readSize?: number;
      offset?: number;
      onPacketReceived?: (
        packet: Uint8Array,
        progress: number,
        totalSize: number,
      ) => void;
    } = {},
  ) {
    // Optimized read for firmware identification with flexible read size and offset:
    // - Default (25KB / 0x6400): Fast path, covers 99% of cases
    // - Additional chunks: Specify offset multiples of 25KB until identification succeeds
    // In testing, most firmwares are identified within the first 25KB read, so reading the entire
    // partition is unnecessary in the majority of cases.

    const baseOffset =
      partitionLabel === 'app0'
        ? this.layout.app0Offset
        : this.layout.app1Offset;

    return this.espLoader.readFlash(
      baseOffset + offset,
      readSize,
      onPacketReceived,
    );
  }

  async writeAppPartition(
    partitionLabel: 'app0' | 'app1',
    data: Uint8Array,
    reportProgress?: (
      fileIndex: number,
      written: number,
      total: number,
    ) => void,
  ) {
    if (data.length > this.layout.appSize) {
      throw new Error(
        `Data cannot be larger than 0x${this.layout.appSize.toString(16)}`,
      );
    }
    if (data.length < 0xf0000) {
      throw new Error(
        `Data seems too small, are you sure this is the right file?`,
      );
    }

    const offset =
      partitionLabel === 'app0'
        ? this.layout.app0Offset
        : this.layout.app1Offset;

    await this.writeData(data, offset, reportProgress);
  }

  private async writeData(
    data: Uint8Array,
    address: number,
    reportProgress?: (
      fileIndex: number,
      written: number,
      total: number,
    ) => void,
  ) {
    await this.espLoader.writeFlash({
      fileArray: [
        {
          data: this.espLoader.ui8ToBstr(data),
          address,
        },
      ],
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',

      eraseAll: false,
      compress: true,
      reportProgress,
    });
  }
}
