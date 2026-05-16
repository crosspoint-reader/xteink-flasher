'use server';

import { getCache } from '@vercel/functions';

type DeviceModel = 'x4' | 'x3';

interface OfficialFirmwareData {
  change_log: string;
  download_url: string;
  version: string;
}

interface OfficialFirmwareVersions {
  en: OfficialFirmwareData;
  ch: OfficialFirmwareData;
}

interface CommunityFirmwareVersions {
  crossPoint: {
    version: string;
    releaseDate: string;
    downloadUrl: string;
  };
}

const x4FirmwareVersionFallback: OfficialFirmwareVersions = {
  en: {
    change_log:
      '1. Optimize EPUB/TXT  \r\n2. Optimize JPG speed  \r\n3. Optimize Wi-Fi connection  \r\n4. Optimize EPUB covers',
    download_url:
      'http://gotaserver.xteink.com/api/download/ESP32C3/V3.1.1/V3.1.1-EN.bin',
    version: 'V3.1.1',
  },
  ch: {
    change_log:
      '1.优化蓝牙卡死\r\n2.优化epub,阻止打开加密书籍\r\n3.优化文件时间写入逻辑\r\n4.调整XTC/XTCH用的灰度波形\r\n5.需重建索引',
    download_url:
      'http://47.122.74.33:5000/api/download/ESP32C3/V3.1.9/V3.1.9_CH_X4_0117.bin',
    version: 'V3.1.9',
  },
};

const x3FirmwareVersionFallback: OfficialFirmwareVersions = {
  en: {
    change_log:
      '1. Optimize EPUB\r\n2. Fix a large number of bugs\r\n3. The index needs to be rebuilt manually',
    download_url:
      'http://8.216.34.42:5001/api/v1/download/ESP32C3_X3/V5.1.6/V5.1.6-X3-EN-PROD-0304_.bin?choose=1&lang=en',
    version: 'V5.1.6',
  },
  ch: {
    change_log: '',
    download_url:
      'https://domestic-upload-file-api.oss-cn-hangzhou.aliyuncs.com/admin_uploads/firmware/202603/26/751e134f-22b1-4a00-bbfa-0942593ef867/V5.2.13-X3-CH-PROD-0326_173844.bin',
    version: 'V5.2.13',
  },
};

const x4ChineseFirmwareCheckUrl =
  'https://api-prod.xteink.cn/api/v1/check-update?current_version=V5.1.0&device_type=ESP32C3&device_id=12345&lng=en';
const x4EnglishFirmwareCheckUrl =
  'https://api-prod.xteink.cc/api/v1/check-update?current_version=V5.1.0&device_type=ESP32C3&device_id=12345&lng=en';
const x3ChineseFirmwareCheckUrl =
  'https://api-prod.xteink.cn/api/v1/check-update?current_version=V5.1.0&device_type=ESP32C3_X3&device_id=12345&lng=en';
const x3EnglishFirmwareCheckUrl =
  'https://api-prod.xteink.cc/api/v1/check-update?current_version=V5.1.0&device_type=ESP32C3_X3&device_id=12345&lng=en';

export async function getOfficialFirmwareRemoteData(
  deviceModel: DeviceModel,
): Promise<OfficialFirmwareVersions> {
  const cache = getCache();
  const cacheKey = `firmware-versions.official.${deviceModel}.v1`;
  const fallback =
    deviceModel === 'x3'
      ? x3FirmwareVersionFallback
      : x4FirmwareVersionFallback;

  const value = (await cache.get(cacheKey)) as OfficialFirmwareVersions | null;
  if (value) {
    return value;
  }

  if (deviceModel === 'x3') {
    return Promise.all([
      fetch(x3ChineseFirmwareCheckUrl),
      fetch(x3EnglishFirmwareCheckUrl),
    ])
      .then(([chRes, enRes]) => Promise.all([chRes.json(), enRes.json()]))
      .then(async ([chData, enData]) => {
        const data: OfficialFirmwareVersions = {
          en: enData.data,
          ch: chData.data,
        };

        await cache.set(cacheKey, data, {
          ttl: 60 * 60 * 24, // 24 hours
        });

        return data;
      })
      .catch(() => fallback);
  }

  return Promise.all([
    fetch(x4ChineseFirmwareCheckUrl),
    fetch(x4EnglishFirmwareCheckUrl),
  ])
    .then(([chRes, enRes]) => Promise.all([chRes.json(), enRes.json()]))
    .then(async ([chData, enData]) => {
      const data: OfficialFirmwareVersions = {
        en: enData.data,
        ch: chData.data,
      };

      await cache.set(cacheKey, data, {
        ttl: 60 * 60 * 24, // 24 hours
      });

      return data;
    })
    .catch(() => fallback);
}

export async function getOfficialFirmwareVersions(deviceModel: DeviceModel) {
  const data = await getOfficialFirmwareRemoteData(deviceModel);

  return {
    en: data.en.version,
    ch: data.ch.version,
  };
}

export async function getCommunityFirmwareRemoteData(): Promise<CommunityFirmwareVersions> {
  const cache = getCache();
  const cacheKey = 'firmware-versions.community.v1';

  const value = (await cache.get(cacheKey)) as CommunityFirmwareVersions | null;
  if (value) {
    return value;
  }

  const releaseData = await fetch(
    'https://api.github.com/repos/crosspoint-reader/crosspoint-reader/releases/latest',
  ).then((resp) => resp.json());

  const firmwareAsset = releaseData.assets.find((asset: any) =>
    asset.name.endsWith('firmware.bin'),
  );
  if (!firmwareAsset) {
    throw new Error('CrossPoint firmware asset not found');
  }

  const data = {
    crossPoint: {
      version: releaseData.tag_name,
      releaseDate: new Date(releaseData.published_at)
        .toISOString()
        .slice(0, 10),
      downloadUrl: firmwareAsset.browser_download_url,
    },
  };

  await cache.set(cacheKey, data, {
    ttl: 60 * 60, // 1 hour
  });

  return data;
}

export async function getOfficialFirmware(
  region: 'en' | 'ch',
  deviceModel: DeviceModel,
) {
  const url = await getOfficialFirmwareRemoteData(deviceModel).then(
    (data) => data[region].download_url,
  );
  const response = await fetch(url);
  return new Uint8Array(await response.arrayBuffer());
}

export async function getCommunityFirmware(_firmware: 'CrossPoint') {
  const releaseData = await getCommunityFirmwareRemoteData().then(
    (data) => data.crossPoint,
  );

  const response = await fetch(releaseData.downloadUrl);
  return new Uint8Array(await response.arrayBuffer());
}
