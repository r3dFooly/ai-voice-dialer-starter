"use client";

import * as React from "react";
import { toast as sonnerToast } from "sonner";

import { Toaster as ShadcnToaster } from "@/components/ui/sonner";

export type ToasterPosition =
  | "top-left"
  | "top-right"
  | "top-center"
  | "bottom-left"
  | "bottom-right"
  | "bottom-center";

export type ToasterProps = {
  position?: ToasterPosition;
  theme?: "light" | "dark" | "system";
};

/**
 * Project-styled wrapper around sonner. Mount once at the app root layout.
 * For programmatic toasts, import the `toast` helper exported below.
 */
export function Toaster({ position = "bottom-right", theme = "dark" }: ToasterProps) {
  return <ShadcnToaster position={position} theme={theme} richColors closeButton />;
}

/**
 * Pre-themed toast helpers. Each variant reuses sonner's built-in styling but
 * keeps the call-site terse:
 *   toast.success("Saved");
 *   toast.error(err.message);
 */
export const toast = {
  success: (message: string, opts?: Parameters<typeof sonnerToast>[1]) =>
    sonnerToast.success(message, opts),
  error: (message: string, opts?: Parameters<typeof sonnerToast>[1]) =>
    sonnerToast.error(message, opts),
  info: (message: string, opts?: Parameters<typeof sonnerToast>[1]) =>
    sonnerToast.info(message, opts),
  warning: (message: string, opts?: Parameters<typeof sonnerToast>[1]) =>
    sonnerToast.warning(message, opts),
  default: sonnerToast,
};
