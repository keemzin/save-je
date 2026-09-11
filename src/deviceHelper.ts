import { Platform } from "obsidian";
import type { SaveJeSettings } from "./types";

/**
 * Auto-detects a friendly default device name based on the current platform.
 */
export function getDefaultDeviceName(): string {
  if (Platform.isIosApp) {
    return Platform.isPhone ? "iPhone" : "iPad";
  }
  if (Platform.isAndroidApp) {
    return Platform.isPhone ? "Android Phone" : "Android Tablet";
  }
  if (Platform.isMacOS) {
    return "Mac";
  }
  if (Platform.isWin) {
    return "Windows PC";
  }
  if (Platform.isLinux) {
    return "Linux PC";
  }
  if (Platform.isMobile) {
    return "Mobile Device";
  }
  return "Desktop Device";
}

/**
 * Returns the configured device name or the auto-detected platform name if unset.
 */
export function getEffectiveDeviceName(
  settings?: SaveJeSettings | null
): string {
  if (settings?.deviceName && settings.deviceName.trim().length > 0) {
    return settings.deviceName.trim();
  }
  return getDefaultDeviceName();
}

/**
 * Encodes a device name for safe storage in S3 user metadata (x-amz-meta-devicename).
 * S3 metadata strictly requires US-ASCII characters.
 */
export function encodeDeviceMetadata(name: string): string {
  try {
    return encodeURIComponent(name.trim());
  } catch {
    return name.trim().replace(/[^\x20-\x7E]/g, "");
  }
}

/**
 * Decodes a device name retrieved from S3 user metadata.
 */
export function decodeDeviceMetadata(raw?: string): string | undefined {
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  try {
    return decodeURIComponent(raw.trim());
  } catch {
    return raw.trim();
  }
}

/**
 * Extracts and decodes device name from an S3 user metadata dictionary.
 * S3 converts user metadata keys to lowercase (e.g. "devicename").
 */
export function extractDeviceNameFromMetadata(
  metadata?: Record<string, string>
): string | undefined {
  if (!metadata) return undefined;
  const raw =
    metadata.devicename ||
    metadata["device-name"] ||
    metadata.devicename ||
    metadata.device;
  return decodeDeviceMetadata(raw);
}

/**
 * Sanitizes a device name for safe inclusion in file paths and filenames.
 * Replaces illegal filename characters and spaces with hyphens/underscores.
 * e.g. "Hakeem's iPhone 15 Pro" -> "iPhone_15_Pro"
 */
export function sanitizeDeviceNameForPath(name: string): string {
  return (
    name
      .trim()
      // Replace illegal characters for Windows/macOS/Linux/Android: \ / : * ? " < > |
      .replace(/[\\/:*?"<>|]+/g, "")
      // Replace whitespace with underscore
      .replace(/\s+/g, "_")
      // Remove leading/trailing dashes or underscores
      .replace(/^[-_]+|[-_]+$/g, "") || "Device"
  );
}

/**
 * Humanizes a sanitized device name segment back to a readable string.
 * e.g. "iPhone_15_Pro" -> "iPhone 15 Pro"
 */
export function humanizeSanitizedDeviceName(sanitized: string): string {
  return sanitized.replace(/_+/g, " ").trim();
}
