# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2025-07-23

### 🔧 Fixed

#### Performance Improvements
- **Backpressure optimization**: Replaced inefficient busy-wait loops with exponential backoff algorithm (10ms → 100ms cap) in encoder worker, significantly reducing CPU usage during queue management
- **Memory leak prevention**: Fixed VideoFrame resource management in `convertToVideoFrame` utility by implementing clear ownership model - always returns new VideoFrame instances with proper cleanup

#### Browser Compatibility
- **WebM audio-only encoding**: Enhanced WebMMuxerWrapper to properly handle audio-only scenarios by detecting video-disabled configurations (`width === 0 || height === 0 || videoBitrate === 0`)
- **Safari transferable objects**: Improved Safari compatibility for VideoFrame and AudioData transfer in worker communication

#### Architecture Improvements
- **Worker singleton elimination**: Fixed critical concurrency issue where all WorkerCommunicator instances shared a single worker. Each instance now creates its own dedicated worker, enabling true parallel encoding operations
- **Progress tracking enhancement**: Implemented `totalFrames` transmission from main thread to workers, enabling accurate progress calculation for video encoding operations across all source types
- **Streaming API expansion**: Added comprehensive VideoFile support to streaming encoder (`encodeStream()`), allowing video files to be processed with real-time chunk output
- **Configuration system upgrade**: Added `firstTimestampBehavior` top-level configuration option with proper cascading to muxer implementations for consistent timestamp handling
- **Latency mode consolidation**: Unified `latencyMode` configuration at top level with automatic propagation to video encoder and muxer settings, eliminating need for nested configuration

#### Security Enhancements
- **Production environment detection**: Enhanced security checks to include staging/preview environments (`NODE_ENV: staging|preview|prod`) and added explicit disable mechanism via `WEBCODECS_DISABLE_INLINE_WORKER` environment variable
- **Stricter domain validation**: Improved production environment detection with better domain pattern matching and development port exclusion

#### Error Handling
- **MediaStream exception handling**: Fixed error-swallowing `.catch()` handlers in streaming encoder to ensure exceptions properly propagate to user callbacks and error handlers
- **Type consistency**: Synchronized `EncodeErrorType` union type with `EncoderErrorType` enum by adding missing values (`InvalidInput`, `FilesystemError`, `Unknown`) and removing unused entries

### 🏗️ Internal Changes
- **Type system cleanup**: Aligned internal error type definitions between public API and worker implementation
- **Test fixes**: Updated test expectations to match new error type mappings (`"internal-error"` → `"unknown"`)
- **Code formatting**: Applied consistent formatting across all source files

### 📋 Technical Details

The changes maintain full backward compatibility while addressing critical performance, security, reliability, and architectural issues identified in code review. All fixes have been thoroughly tested with both unit tests (203 tests passing) and integration tests (browser-based WebCodecs tests passing).

Key areas improved:

- **Concurrency architecture**: Worker singleton elimination enables true parallel encoding operations
- **Progress tracking**: Accurate totalFrames transmission provides better user experience across all source types  
- **API consistency**: Unified configuration system with top-level latencyMode and firstTimestampBehavior options
- **Streaming capabilities**: Comprehensive VideoFile support in real-time streaming encoder
- **CPU efficiency**: Exponential backoff reduces busy-waiting in encoding queues
- **Memory management**: Clear VideoFrame ownership prevents GPU memory leaks
- **Cross-browser support**: Enhanced Safari compatibility and WebM audio-only encoding
- **Production security**: Stricter environment detection prevents inline worker usage in production
- **Error reliability**: Proper exception propagation ensures debugging visibility

---

## [0.2.2] - 2025-01-14

### 🎉 Added

- **Real-time streaming support**: Added `encodeStream()` function for streaming video encoding with chunk-by-chunk output
- **Audio-only encoding**: Support for `video: false` option to encode audio-only content
- **VideoFile audio processing**: Enhanced VideoFile support with audio track extraction and encoding
- **Transferable objects optimization**: Improved worker communication performance with optimized object transfer

### 🔧 Enhanced

- **MediaStreamRecorder improvements**: Removed AudioWorklet dependency for broader browser compatibility
- **Build system updates**: Updated build configuration and exports for better module resolution
- **Test coverage expansion**: Added comprehensive tests for new streaming features

### 📚 Documentation

- **README updates**: Updated examples and API documentation for v0.2.2 features
- **Type definitions**: Enhanced TypeScript definitions for new streaming API

---

## [0.2.1] - Previous Release

- Add VideoFile support and remove AudioWorklet
- Update version to 0.2.1 in package.json and README.md
- Simplify MediaStreamRecorder API
- Clean up build configuration and exports
- Update tests and maintain test coverage

---

## [0.1.1] - Initial Release

- Basic functional API with encode() function
- Support for H.264/AVC, VP9, VP8 video codecs
- Support for AAC, Opus audio codecs  
- MP4 and WebM container formats
- WebCodecs API integration
- TypeScript support