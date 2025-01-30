/**
 * Copyright (c) Streamlit Inc. (2018-2022) Snowflake Inc. (2022-2024)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React, {
  memo,
  ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

import { useTheme } from "@emotion/react"
import WaveSurfer from "wavesurfer.js"
import RecordPlugin from "wavesurfer.js/dist/plugins/record"
import { Delete, FileDownload } from "@emotion-icons/material-outlined"
import isEqual from "lodash/isEqual"

import { FormClearHelper } from "@streamlit/lib/src/components/widgets/Form"
import { FileUploadClient } from "@streamlit/lib/src/FileUploadClient"
import { WidgetStateManager } from "@streamlit/lib/src/WidgetStateManager"
import { AudioInput as AudioInputProto } from "@streamlit/lib/src/proto"
import Toolbar, {
  ToolbarAction,
} from "@streamlit/lib/src/components/shared/Toolbar"
import {
  isNullOrUndefined,
  labelVisibilityProtoValueToEnum,
  notNullOrUndefined,
} from "@streamlit/lib/src/util/utils"
import { blend, convertRemToPx } from "@streamlit/lib/src/theme/utils"
import { uploadFiles } from "@streamlit/lib/src/util/uploadFiles"
import TooltipIcon from "@streamlit/lib/src/components/shared/TooltipIcon"
import { Placement } from "@streamlit/lib/src/components/shared/Tooltip"
import { WidgetLabel } from "@streamlit/lib/src/components/widgets/BaseWidget"
import { usePrevious } from "@streamlit/lib/src/util/Hooks"
import useWidgetManagerElementState from "@streamlit/lib/src/hooks/useWidgetManagerElementState"
import useDownloadUrl from "@streamlit/lib/src/hooks/useDownloadUrl"

import {
  StyledAudioInputContainerDiv,
  StyledWaveformContainerDiv,
  StyledWaveformInnerDiv,
  StyledWaveformTimeCode,
  StyledWaveSurferDiv,
  StyledWidgetLabelHelp,
} from "./styled-components"
import NoMicPermissions from "./NoMicPermissions"
import Placeholder from "./Placeholder"
import {
  BAR_GAP,
  BAR_RADIUS,
  BAR_WIDTH,
  CURSOR_WIDTH,
  STARTING_TIME_STRING,
  WAVEFORM_PADDING,
} from "./constants"
import formatTime from "./formatTime"
import AudioInputActionButtons from "./AudioInputActionButtons"
import convertAudioToWav from "./convertAudioToWav"
import AudioInputErrorState from "./AudioInputErrorState"

/** Props for the AudioInput component. */
export interface Props {
  element: AudioInputProto
  uploadClient: FileUploadClient
  widgetMgr: WidgetStateManager
  fragmentId?: string
  disabled: boolean
}

/**
 * A custom widget for recording audio. Allows selecting an input device
 * (e.g., Bluetooth mic) directly, then capturing audio, visualizing it,
 * and uploading it to the Streamlit server.
 */
const AudioInput: React.FC<Props> = ({
  element,
  uploadClient,
  widgetMgr,
  fragmentId,
  disabled,
}): ReactElement => {
  const theme = useTheme()
  const previousTheme = usePrevious(theme)

  // Reference for the WaveSurfer container
  const waveSurferRef = useRef<HTMLDivElement | null>(null)

  // Primary WaveSurfer instance + record plugin
  const [wavesurfer, setWavesurfer] = useState<WaveSurfer | null>(null)
  const [recordPlugin, setRecordPlugin] = useState<RecordPlugin | null>(null)

  // State for enumerated devices and selected device
  const [availableAudioDevices, setAvailableAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [activeAudioDeviceId, setActiveAudioDeviceId] = useState<string | null>(null)

  // Internal states stored via custom hooks (preserving across reruns in Streamlit)
  const [deleteFileUrl, setDeleteFileUrl] = useWidgetManagerElementState<string | null>({
    widgetMgr,
    id: element.id,
    key: "deleteFileUrl",
    defaultValue: null,
  })
  const [recordingUrl, setRecordingUrl] = useWidgetManagerElementState<string | null>({
    widgetMgr,
    id: element.id,
    key: "recordingUrl",
    defaultValue: null,
  })
  const [recordingTime, setRecordingTime] = useWidgetManagerElementState<string>({
    widgetMgr,
    id: element.id,
    formId: element.formId,
    key: "recordingTime",
    defaultValue: STARTING_TIME_STRING,
  })

  // Local UI states
  const [progressTime, setProgressTime] = useState(STARTING_TIME_STRING)
  const [shouldUpdatePlaybackTime, setShouldUpdatePlaybackTime] = useState(false)
  const [hasNoMicPermissions, setHasNoMicPermissions] = useState(false)
  const [hasRequestedMicPermissions, setHasRequestedMicPermissions] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [isError, setIsError] = useState(false)
  const [, setRerender] = useState(0)
  const forceRerender = (): void => setRerender(x => x + 1)

  const widgetId = element.id
  const widgetFormId = element.formId

  /** Convert (or keep) the audio Blob to WAV and upload to Streamlit. */
  const transcodeAndUploadFile = useCallback(
    async (blob: Blob) => {
      setIsUploading(true)
      if (notNullOrUndefined(widgetFormId)) {
        widgetMgr.setFormsWithUploadsInProgress(new Set([widgetFormId]))
      }

      let wavBlob: Blob | undefined
      if (blob.type === "audio/wav") {
        wavBlob = blob
      } else {
        wavBlob = await convertAudioToWav(blob)
      }

      if (!wavBlob) {
        setIsError(true)
        return
      }

      // Create an object URL to store locally, set state to show playback
      const url = URL.createObjectURL(wavBlob)
      const timestamp = new Date().toISOString().slice(0, 16).replace(":", "-")
      const file = new File([wavBlob], `${timestamp}_audio.wav`, {
        type: wavBlob.type,
      })

      setRecordingUrl(url)

      // Upload the newly created WAV file
      uploadFiles({
        files: [file],
        uploadClient,
        widgetMgr,
        widgetInfo: { id: widgetId, formId: widgetFormId },
        fragmentId,
      })
        .then(({ successfulUploads, failedUploads }) => {
          if (failedUploads.length > 0) {
            setIsError(true)
            return
          }
          const upload = successfulUploads[0]
          if (upload?.fileUrl.deleteUrl) {
            setDeleteFileUrl(upload.fileUrl.deleteUrl)
          }
        })
        .finally(() => {
          if (notNullOrUndefined(widgetFormId)) {
            widgetMgr.setFormsWithUploadsInProgress(new Set())
          }
          setIsUploading(false)
        })
    },
    [
      uploadClient,
      widgetMgr,
      setRecordingUrl,
      setDeleteFileUrl,
      widgetId,
      widgetFormId,
      fragmentId,
    ]
  )

  /** Clear the current recording from the WaveSurfer and state. */
  const handleClear = useCallback(
    ({
      updateWidgetManager,
      deleteFile,
    }: {
      updateWidgetManager: boolean
      deleteFile: boolean
    }) => {
      if (isNullOrUndefined(wavesurfer) || isNullOrUndefined(deleteFileUrl)) {
        return
      }
      setRecordingUrl(null)
      wavesurfer.empty()

      if (deleteFile) {
        uploadClient.deleteFile(deleteFileUrl)
      }
      setDeleteFileUrl(null)

      setProgressTime(STARTING_TIME_STRING)
      setRecordingTime(STARTING_TIME_STRING)

      if (updateWidgetManager) {
        widgetMgr.setFileUploaderStateValue(
          element,
          {},
          { fromUi: true },
          fragmentId
        )
      }

      setShouldUpdatePlaybackTime(false)
      if (notNullOrUndefined(recordingUrl)) {
        URL.revokeObjectURL(recordingUrl)
      }
    },
    [
      wavesurfer,
      widgetMgr,
      fragmentId,
      deleteFileUrl,
      recordingUrl,
      setDeleteFileUrl,
      setRecordingTime,
      setRecordingUrl,
      element,
    ]
  )

  /** Clear the recording on form reset (if this widget is inside a form). */
  useEffect(() => {
    if (isNullOrUndefined(widgetFormId)) return

    const formClearHelper = new FormClearHelper()
    formClearHelper.manageFormClearListener(widgetMgr, widgetFormId, () =>
      handleClear({ updateWidgetManager: true, deleteFile: false })
    )

    return () => formClearHelper.disconnect()
  }, [widgetFormId, handleClear, widgetMgr])

  /** Create and configure the WaveSurfer + RecordPlugin instance. */
  const initializeWaveSurfer = useCallback(() => {
    if (!waveSurferRef.current) return

    const ws = WaveSurfer.create({
      container: waveSurferRef.current,
      waveColor: recordingUrl
        ? blend(theme.colors.fadedText40, theme.colors.secondaryBg)
        : theme.colors.primary,
      progressColor: theme.colors.bodyText,
      height: convertRemToPx(theme.sizes.largestElementHeight) - 2 * WAVEFORM_PADDING,
      barWidth: BAR_WIDTH,
      barGap: BAR_GAP,
      barRadius: BAR_RADIUS,
      cursorWidth: CURSOR_WIDTH,
      url: recordingUrl ?? undefined,
    })

    ws.on("timeupdate", time => {
      // Convert seconds to ms, then format
      setProgressTime(formatTime(time * 1000))
    })
    ws.on("pause", () => forceRerender())

    // Install record plugin
    const rp = ws.registerPlugin(
      RecordPlugin.create({
        scrollingWaveform: false,
        renderRecordedAudio: true,
      })
    )

    // On record end, automatically upload the audio
    rp.on("record-end", async (blob: Blob) => {
      await transcodeAndUploadFile(blob)
    })

    // Update local "recording time" as we record
    rp.on("record-progress", time => {
      setRecordingTime(formatTime(time))
    })

    setWavesurfer(ws)
    setRecordPlugin(rp)

    return () => {
      ws.destroy()
      rp.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcodeAndUploadFile]) // exclude theme so we don't recreate every time

  useEffect(() => initializeWaveSurfer(), [initializeWaveSurfer])

  /** If theme changed, update wave + progress colors. */
  useEffect(() => {
    if (!isEqual(previousTheme, theme)) {
      wavesurfer?.setOptions({
        waveColor: recordingUrl
          ? blend(theme.colors.fadedText40, theme.colors.secondaryBg)
          : theme.colors.primary,
        progressColor: theme.colors.bodyText,
      })
    }
  }, [theme, previousTheme, recordingUrl, wavesurfer])

  /**
   * Ask for mic permission, then enumerate devices and store them in state.
   * We do this on mount (if not done before) so that once user grants access,
   * device labels become visible.
   */
  useEffect(() => {
    if (hasRequestedMicPermissions) {
      return
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(() => {
        setHasRequestedMicPermissions(true)
        return RecordPlugin.getAvailableAudioDevices()
      })
      .then(devices => {
        const audioInputs = devices.filter(d => d.kind === "audioinput")
        setAvailableAudioDevices(audioInputs)
        // Optionally, auto-select the first device
        if (audioInputs.length > 0) {
          setActiveAudioDeviceId(audioInputs[0].deviceId)
        }
      })
      .catch(err => {
        console.error("Failed to get microphone permissions or devices:", err)
        setHasNoMicPermissions(true)
      })
  }, [hasRequestedMicPermissions])

  /** Let user pick the active device from a dropdown. */
  const handleDeviceChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setActiveAudioDeviceId(event.target.value)
    },
    []
  )

  /** Toggle play/pause for the recorded audio. */
  const onClickPlayPause = useCallback(() => {
    if (wavesurfer) {
      wavesurfer.playPause()
      // We'll start tracking progressTime from now on
      setShouldUpdatePlaybackTime(true)
      forceRerender()
    }
  }, [wavesurfer])

  /** Start a new recording with the chosen device. */
  const startRecording = useCallback(async () => {
    if (!recordPlugin || !wavesurfer) {
      console.error("Recording setup is not initialized.")
      return
    }

    // If there's an existing recording, clear it first
    if (recordingUrl) {
      handleClear({ updateWidgetManager: false, deleteFile: true })
    }

    // Wave color for "live recording" state
    wavesurfer.setOptions({
      waveColor: theme.colors.primary,
    })

    try {
      await recordPlugin.startRecording({
        deviceId: activeAudioDeviceId || undefined,
      })
      console.log("Recording started with device:", activeAudioDeviceId)
      forceRerender()
    } catch (err) {
      console.error("Error starting recording:", err)
    }
  }, [
    recordPlugin,
    wavesurfer,
    activeAudioDeviceId,
    recordingUrl,
    handleClear,
    theme,
  ])

  /** Stop recording (and let the record-end event handle the upload). */
  const stopRecording = useCallback(() => {
    if (!recordPlugin) return
    recordPlugin.stopRecording()

    // Once recording is stopped, revert waveColor to a "non-recording" color
    wavesurfer?.setOptions({
      waveColor: blend(theme.colors.fadedText40, theme.colors.secondaryBg),
    })
  }, [recordPlugin, wavesurfer, theme])

  /** Hook to download the recorded WAV directly from the browser. */
  const downloadRecording = useDownloadUrl(recordingUrl, "recording.wav")

  // Condition checks
  const isRecording = Boolean(recordPlugin?.isRecording())
  const isPlaying = Boolean(wavesurfer?.isPlaying())
  const isPlayingOrRecording = isRecording || isPlaying

  const showPlaceholder = !isRecording && !recordingUrl && !hasNoMicPermissions
  const showNoMicPermissionsOrPlaceholderOrError =
    hasNoMicPermissions || showPlaceholder || isError

  // If disabled or no permission => can't record or switch devices
  const isDisabled = disabled || hasNoMicPermissions

  return (
    <StyledAudioInputContainerDiv
      className="stAudioInput"
      data-testid="stAudioInput"
    >
      <WidgetLabel
        label={element.label}
        disabled={isDisabled}
        labelVisibility={labelVisibilityProtoValueToEnum(
          element.labelVisibility?.value
        )}
      >
        {element.help && (
          <StyledWidgetLabelHelp>
            <TooltipIcon content={element.help} placement={Placement.TOP} />
          </StyledWidgetLabelHelp>
        )}
      </WidgetLabel>

      {/*
        (Optional) Render device selection if we detect multiple mics.
        You can remove the length check to always show the dropdown.
      */}
      {availableAudioDevices.length > 1 && (
        <div style={{ marginBottom: "0.5rem" }}>
          <label htmlFor="audioDeviceSelect" style={{ marginRight: "0.5rem" }}>
            Select Microphone:
          </label>
          <select
            id="audioDeviceSelect"
            value={activeAudioDeviceId || ""}
            onChange={handleDeviceChange}
            disabled={isDisabled}
          >
            {availableAudioDevices.map(device => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Device ${device.deviceId}`}
              </option>
            ))}
          </select>
        </div>
      )}

      <StyledWaveformContainerDiv>
        <Toolbar
          isFullScreen={false}
          disableFullscreenMode
          target={StyledWaveformContainerDiv}
        >
          {recordingUrl && (
            <ToolbarAction
              label="Download as WAV"
              icon={FileDownload}
              onClick={() => downloadRecording()}
            />
          )}
          {deleteFileUrl && (
            <ToolbarAction
              label="Clear recording"
              icon={Delete}
              onClick={() =>
                handleClear({ updateWidgetManager: true, deleteFile: true })
              }
            />
          )}
        </Toolbar>

        <AudioInputActionButtons
          isRecording={isRecording}
          isPlaying={isPlaying}
          isUploading={isUploading}
          isError={isError}
          recordingUrlExists={Boolean(recordingUrl)}
          startRecording={startRecording}
          stopRecording={stopRecording}
          onClickPlayPause={onClickPlayPause}
          onClear={() => {
            handleClear({ updateWidgetManager: false, deleteFile: true })
            setIsError(false)
          }}
          disabled={isDisabled}
        />

        <StyledWaveformInnerDiv>
          {isError && <AudioInputErrorState />}
          {showPlaceholder && <Placeholder />}
          {hasNoMicPermissions && <NoMicPermissions />}
          <StyledWaveSurferDiv
            data-testid="stAudioInputWaveSurfer"
            ref={waveSurferRef}
            show={!showNoMicPermissionsOrPlaceholderOrError}
          />
        </StyledWaveformInnerDiv>

        <StyledWaveformTimeCode
          isPlayingOrRecording={isPlayingOrRecording}
          data-testid="stAudioInputWaveformTimeCode"
        >
          {shouldUpdatePlaybackTime ? progressTime : recordingTime}
        </StyledWaveformTimeCode>
      </StyledWaveformContainerDiv>
    </StyledAudioInputContainerDiv>
  )
}

export default memo(AudioInput)
