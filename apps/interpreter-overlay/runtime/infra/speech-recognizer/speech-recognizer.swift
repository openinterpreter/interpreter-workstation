/// speech-recognizer — Real-time speech recognition via macOS SFSpeechRecognizer.
///
/// Reads raw 16kHz 16-bit mono PCM from stdin and writes JSON transcript lines
/// to stdout as interim results arrive. Uses on-device recognition (no network).
///
/// Output format (one JSON object per line, flushed immediately):
///   {"text":"hello world","isFinal":false}
///   {"text":"hello world how are you","isFinal":false}
///   {"text":"hello world how are you","isFinal":true}
///
/// Usage:
///   cat audio.raw | ./speech-recognizer --locale en-US
///   # Or pipe PCM from a live mic capture

import Foundation
import Speech
import AVFoundation

// MARK: - JSON output

struct TranscriptOutput: Codable {
    let text: String
    let isFinal: Bool
}

func emitTranscript(_ text: String, isFinal: Bool) {
    let output = TranscriptOutput(text: text, isFinal: isFinal)
    guard let data = try? JSONEncoder().encode(output),
          let json = String(data: data, encoding: .utf8) else { return }
    print(json)
    fflush(stdout)
}

func emitError(_ message: String) {
    let json = "{\"error\":\"\(message.replacingOccurrences(of: "\"", with: "\\\""))\"}"
    FileHandle.standardError.write(Data((json + "\n").utf8))
}

// MARK: - Main

class SpeechRecognizerCLI {
    let recognizer: SFSpeechRecognizer
    var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    var recognitionTask: SFSpeechRecognitionTask?
    let audioFormat: AVAudioFormat

    init(localeIdentifier: String) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
            emitError("SFSpeechRecognizer not available for \(localeIdentifier)")
            exit(1)
        }
        self.recognizer = recognizer

        guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false) else {
            emitError("Failed to create audio format")
            exit(1)
        }
        self.audioFormat = format
    }

    func requestAuthorization(completion: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            switch status {
            case .authorized:
                completion(true)
            case .denied:
                emitError("Speech recognition permission denied")
                completion(false)
            case .restricted:
                emitError("Speech recognition restricted on this device")
                completion(false)
            case .notDetermined:
                emitError("Speech recognition permission not determined")
                completion(false)
            @unknown default:
                emitError("Unknown speech recognition authorization status")
                completion(false)
            }
        }
    }

    func startRecognition() {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true

        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        self.recognitionRequest = request

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            if let result = result {
                let text = result.bestTranscription.formattedString
                emitTranscript(text, isFinal: result.isFinal)

                if result.isFinal {
                    self?.recognitionRequest = nil
                    self?.recognitionTask = nil
                }
            }

            if let error = error {
                let nsError = error as NSError
                // Code 1 = "no speech detected" or session ended — not a real error
                if nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 1 {
                    return
                }
                emitError("Recognition error: \(error.localizedDescription)")
            }
        }
    }

    func feedAudioFromStdin() {
        let stdinFd = FileHandle.standardInput.fileDescriptor
        let ioChannel = DispatchIO(type: .stream, fileDescriptor: stdinFd, queue: DispatchQueue.main) { error in
            if error != 0 {
                emitError("stdin read error: \(error)")
            }
        }
        ioChannel.setLimit(lowWater: 1)

        ioChannel.read(offset: 0, length: Int.max, queue: DispatchQueue.main) { [weak self] done, data, error in
            guard let self = self else { return }

            if let data = data, !data.isEmpty {
                let sampleCount = data.count / 2 // 16-bit = 2 bytes per sample
                guard sampleCount > 0 else { return }

                guard let buffer = AVAudioPCMBuffer(pcmFormat: self.audioFormat, frameCapacity: AVAudioFrameCount(sampleCount)) else {
                    return
                }
                buffer.frameLength = AVAudioFrameCount(sampleCount)

                let channelData = buffer.int16ChannelData![0]
                data.withUnsafeBytes { (ptr: UnsafePointer<Int16>) in
                    channelData.update(from: ptr, count: sampleCount)
                }

                self.recognitionRequest?.append(buffer)
            }

            if done {
                self.recognitionRequest?.endAudio()
                // Give time for final result to arrive
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                    exit(0)
                }
            }
        }
    }

    func run() {
        requestAuthorization { [weak self] authorized in
            guard authorized, let self = self else {
                exit(1)
            }
            self.startRecognition()
            self.feedAudioFromStdin()
        }
    }
}

func parseLocaleIdentifier() -> String {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard !arguments.isEmpty else {
        return "en-US"
    }

    if arguments.count == 2 && arguments[0] == "--locale" {
        let localeIdentifier = arguments[1].trimmingCharacters(in: .whitespacesAndNewlines)
        if !localeIdentifier.isEmpty {
            return localeIdentifier
        }
    }

    if arguments.count == 1 && arguments[0].hasPrefix("--locale=") {
        let localeIdentifier = String(arguments[0].dropFirst("--locale=".count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !localeIdentifier.isEmpty {
            return localeIdentifier
        }
    }

    emitError("Usage: speech-recognizer --locale <locale-identifier>")
    exit(1)
}

let cli = SpeechRecognizerCLI(localeIdentifier: parseLocaleIdentifier())
cli.run()
dispatchMain()
