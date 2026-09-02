// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
// Stable C ABI exposed by the built-in Rust terminal bridge.

#pragma once

#include <cstddef>
#include <cstdint>

extern "C"
{
    using TerminalBridgeCommandCallback = void (*)(void* context,
                                                   const char16_t* sessionId,
                                                   size_t sessionIdLength,
                                                   uint32_t kind,
                                                   const char16_t* data,
                                                   size_t dataLength,
                                                   uint32_t rows,
                                                   uint32_t cols);

    bool tbr_initialize(const char16_t* assetRoot,
                        size_t assetRootLength,
                        const char16_t* dataRoot,
                        size_t dataRootLength,
                        bool automaticPort,
                        uint16_t port,
                        const char16_t* bindAddress,
                        size_t bindAddressLength,
                        bool webInterfaceEnabled,
                        void* context,
                        TerminalBridgeCommandCallback callback) noexcept;

    void tbr_register_session(const char16_t* id,
                              size_t idLength,
                              const char16_t* title,
                              size_t titleLength,
                              const char16_t* shell,
                              size_t shellLength,
                              const char16_t* cwd,
                              size_t cwdLength,
                              uint32_t pid,
                              uint32_t cols,
                              uint32_t rows) noexcept;
    void tbr_forward_output(const char16_t* id, size_t idLength, const char16_t* data, size_t dataLength) noexcept;
    void tbr_forward_title(const char16_t* id, size_t idLength, const char16_t* title, size_t titleLength) noexcept;
    void tbr_set_project(const char16_t* id, size_t idLength, const char16_t* projectId, size_t projectIdLength) noexcept;
    void tbr_update_cwd(const char16_t* id, size_t idLength, const char16_t* cwd, size_t cwdLength) noexcept;
    void tbr_notify_resize(const char16_t* id, size_t idLength, uint32_t rows, uint32_t cols) noexcept;
    void tbr_notify_exit(const char16_t* id, size_t idLength, uint32_t exitCode) noexcept;
    void tbr_unregister(const char16_t* id, size_t idLength) noexcept;

    uint32_t tbr_status() noexcept;
    size_t tbr_copy_endpoint(char16_t* output, size_t capacity) noexcept;
    size_t tbr_copy_access_token(char16_t* output, size_t capacity) noexcept;
}
