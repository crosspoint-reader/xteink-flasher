'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Heading,
  Em,
  Separator,
  Card,
  Alert,
  Stack,
  Flex,
  HStack,
} from '@chakra-ui/react';
import FileUpload, { FileUploadHandle } from '@/components/FileUpload';
import Steps from '@/components/Steps';
import { useEspOperations } from '@/esp/useEspOperations';
import {
  getOfficialFirmwareVersions,
  getCommunityFirmwareRemoteData,
} from '@/remote/firmwareFetcher';

export default function Home() {
  const { actions, stepData, isRunning, deviceModel, setDeviceModel } =
    useEspOperations();
  const [officialFirmwareVersions, setOfficialFirmwareVersions] = useState<{
    en: string;
    ch: string;
  } | null>(null);
  const [communityFirmwareVersions, setCommunityFirmwareVersions] = useState<{
    crossPoint: { version: string; releaseDate: string };
  } | null>(null);
  const fullFlashFileInput = useRef<FileUploadHandle>(null);
  const appPartitionFileInput = useRef<FileUploadHandle>(null);

  useEffect(() => {
    let cancelled = false;
    setOfficialFirmwareVersions(null);
    getOfficialFirmwareVersions(deviceModel).then((versions) => {
      if (!cancelled) {
        setOfficialFirmwareVersions(versions);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [deviceModel]);

  useEffect(() => {
    getCommunityFirmwareRemoteData().then(setCommunityFirmwareVersions);
  }, []);

  return (
    <Flex direction="column" gap="20px">
      <Stack gap={3} as="section">
        <Heading size="xl">Device model</Heading>
        <HStack gap={3}>
          {(['x4', 'x3'] as const).map((model) => (
            <Button
              key={model}
              variant={deviceModel === model ? 'solid' : 'outline'}
              aria-pressed={deviceModel === model}
              onClick={() => setDeviceModel(model)}
              disabled={isRunning}
            >
              Xteink {model.toUpperCase()}
            </Button>
          ))}
        </HStack>
      </Stack>
      <Separator />
      <Alert.Root status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Proceed with caution</Alert.Title>
          <Alert.Description>
            <Stack>
              <p>
                I’ve tried to make this foolproof and while the likelihood of
                unrecoverable things going wrong is extremely low, it’s never
                zero. So proceed with care and make sure to grab a backup using{' '}
                <b>Save full flash</b> before flashing your device.
              </p>
              <p>
                Once you start <b>Write flash from file</b> or{' '}
                <b>Flash English firmware</b>, you should avoid disconnecting
                your device or closing the tab until the operation is complete.
                Writing a full flash from your backup should always restore your
                device to its old state.
              </p>
            </Stack>
          </Alert.Description>
        </Alert.Content>
      </Alert.Root>

      <Stack gap={3} as="section">
        <div>
          <Heading size="xl">Full flash controls</Heading>
          <Stack gap={1} color="grey" textStyle="sm">
            <p>
              These actions will allow you to take a full backup your Xteink
              device in order to be able to restore it in the case that anything
              goes wrong.
            </p>
            <p>
              <b>Save full flash</b> will read your device’s flash and save it
              as <Em>flash.bin</Em>. This will take around 25 minutes to
              complete. You can use that file (or someone else’s) with{' '}
              <b>Write full flash from file</b> to overwrite your device’s
              entire flash.
            </p>
          </Stack>
        </div>
        <Stack as="section">
          <Button
            variant="subtle"
            onClick={actions.saveFullFlash}
            disabled={isRunning}
          >
            Save full flash
          </Button>
          <Stack direction="row">
            <Flex grow={1}>
              <FileUpload ref={fullFlashFileInput} />
            </Flex>
            <Button
              variant="subtle"
              flexGrow={1}
              onClick={() =>
                actions.writeFullFlash(() =>
                  fullFlashFileInput.current?.getFile(),
                )
              }
              disabled={isRunning}
            >
              Write full flash from file
            </Button>
          </Stack>
        </Stack>
      </Stack>
      <Separator />
      <Stack gap={3} as="section">
        <div>
          <Heading size="xl">OTA fast flash controls</Heading>
          <Stack gap={1} color="grey" textStyle="sm">
            <p>
              Before using this, I’d strongly recommend taking a backup of your
              device using <b>Save full flash</b> above.
            </p>
            <p>
              <b>Flash English/Chinese firmware</b> will download the firmware,
              overwrite the backup partition with the new firmware, and swap
              over to using this partition (leaving your existing firmware as
              the new backup). This is significantly faster than a full flash
              write and will retain all your settings. If it goes wrong, it
              should be fine to run again.
            </p>
          </Stack>
        </div>
        <Stack as="section">
          <Button
            variant="subtle"
            onClick={actions.flashEnglishFirmware}
            disabled={isRunning || !officialFirmwareVersions}
            loading={!officialFirmwareVersions}
          >
            Flash English firmware for {deviceModel.toUpperCase()} (
            {officialFirmwareVersions?.en ?? '...'})
          </Button>
          <Button
            variant="subtle"
            onClick={actions.flashChineseFirmware}
            disabled={isRunning || !officialFirmwareVersions}
            loading={!officialFirmwareVersions}
          >
            Flash Chinese firmware for {deviceModel.toUpperCase()} (
            {officialFirmwareVersions?.ch ?? '...'})
          </Button>
          <Button
            variant="subtle"
            onClick={actions.flashCrossPointFirmware}
            disabled={isRunning || !communityFirmwareVersions}
            loading={!communityFirmwareVersions}
          >
            Flash CrossPoint firmware for {deviceModel.toUpperCase()} (
            {communityFirmwareVersions?.crossPoint.version}) -{' '}
            {communityFirmwareVersions?.crossPoint.releaseDate}
          </Button>
          <Stack direction="row">
            <Flex grow={1}>
              <FileUpload ref={appPartitionFileInput} />
            </Flex>
            <Button
              variant="subtle"
              flexGrow={1}
              onClick={() =>
                actions.flashCustomFirmware(() =>
                  appPartitionFileInput.current?.getFile(),
                )
              }
              disabled={isRunning}
            >
              Flash firmware from file for {deviceModel.toUpperCase()}
            </Button>
          </Stack>
          {process.env.NODE_ENV === 'development' && (
            <Button
              variant="subtle"
              onClick={actions.fakeWriteFullFlash}
              disabled={isRunning}
            >
              Fake write full flash
            </Button>
          )}
        </Stack>
      </Stack>
      <Separator />
      <Card.Root variant="subtle">
        <Card.Header>
          <Heading size="lg">Steps</Heading>
        </Card.Header>
        <Card.Body>
          {stepData.length > 0 ? (
            <Steps steps={stepData} />
          ) : (
            <Alert.Root status="info" variant="surface">
              <Alert.Indicator />
              <Alert.Title>
                Progress will be shown here once you start an operation
              </Alert.Title>
            </Alert.Root>
          )}
        </Card.Body>
      </Card.Root>
      <Alert.Root status="info">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Change device language</Alert.Title>
          <Alert.Description>
            Before starting the process, it is recommended to change the device
            language to English. To do this, select &ldquo;Settings&rdquo; icon,
            then click &ldquo;OK / Confirm&rdquo; button and &ldquo;OK /
            Confirm&rdquo; again until English is shown. Otherwise, the language
            will still be Chinese after flashing and you may not notice changes.
          </Alert.Description>
        </Alert.Content>
      </Alert.Root>
      <Alert.Root status="info">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Device restart instructions</Alert.Title>
          <Alert.Description>
            <Stack>
              <p>
                Once you complete a write operation, you will need to restart
                your device by pressing and releasing the small
                &ldquo;Reset&rdquo; button near the bottom right, followed
                quickly by pressing and holding of the main power button for
                about 3 seconds.
              </p>
              {deviceModel === 'x3' && (
                <p>
                  For CrossPoint firmware, disconnect the USB cable and connect
                  it again instead.
                </p>
              )}
            </Stack>
          </Alert.Description>
        </Alert.Content>
      </Alert.Root>
    </Flex>
  );
}
