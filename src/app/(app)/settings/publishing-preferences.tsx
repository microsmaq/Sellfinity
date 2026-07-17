"use client";

import { useState, useTransition } from "react";
import { setArbitrageAutoPublish } from "@/lib/actions/arbitrage";
import {
  setImproveListingContentPreference,
  setImproveMainImagePreference,
} from "@/lib/actions/mirror-batches";
import {
  AUTO_PUBLISH_MIN_MARGIN_PCT,
  AUTO_PUBLISH_MIN_MATCH_CONFIDENCE,
} from "@/lib/arbitrage/auto-publish";
import { Card, cx } from "@/components/ui";

function PreferenceToggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
  label: string;
}) {
  return (
    <label className="relative inline-flex cursor-pointer items-center">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
        aria-label={label}
      />
      <span className="h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-indigo-600 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 peer-disabled:cursor-wait peer-disabled:opacity-60 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5" />
    </label>
  );
}

export function PublishingPreferences({
  initialAutoPublish,
  initialImproveMainImage,
  initialImproveListingContent,
}: {
  initialAutoPublish: boolean;
  initialImproveMainImage: boolean;
  initialImproveListingContent: boolean;
}) {
  const [autoPublish, setAutoPublish] = useState(initialAutoPublish);
  const [improveMainImage, setImproveMainImage] = useState(initialImproveMainImage);
  const [improveListingContent, setImproveListingContent] = useState(initialImproveListingContent);
  const [savingAutoPublish, startAutoPublishSave] = useTransition();
  const [savingImage, startImageSave] = useTransition();
  const [savingContent, startContentSave] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  function updateAutoPublish(enabled: boolean) {
    const previous = autoPublish;
    setAutoPublish(enabled);
    setMessage(null);
    startAutoPublishSave(async () => {
      try {
        await setArbitrageAutoPublish(enabled);
        setMessage({
          text: enabled
            ? "Automatic publishing is enabled for completed manual and scheduled Arbitrage Finder scans."
            : "Automatic publishing is disabled. Scans will still research products but will not publish them automatically.",
          error: false,
        });
      } catch {
        setAutoPublish(previous);
        setMessage({ text: "Could not save the automatic publishing preference.", error: true });
      }
    });
  }

  function updateImageImprovement(enabled: boolean) {
    const previous = improveMainImage;
    setImproveMainImage(enabled);
    setMessage(null);
    startImageSave(async () => {
      try {
        await setImproveMainImagePreference(enabled);
        setMessage({
          text: enabled
            ? "AI main-image enhancement is enabled for all new Amazon Mirroring and Arbitrage Finder publishing batches."
            : "AI main-image enhancement is disabled. New listings will use their original source images.",
          error: false,
        });
      } catch {
        setImproveMainImage(previous);
        setMessage({ text: "Could not save the AI image preference.", error: true });
      }
    });
  }

  function updateContentImprovement(enabled: boolean) {
    const previous = improveListingContent;
    setImproveListingContent(enabled);
    setMessage(null);
    startContentSave(async () => {
      try {
        await setImproveListingContentPreference(enabled);
        setMessage({
          text: enabled
            ? "AI title and description enhancement is enabled for new mirroring and selected existing listings."
            : "AI copy enhancement is disabled. New mirrored listings will retain the Amazon source copy inside the Sellfinity HTML template.",
          error: false,
        });
      } catch {
        setImproveListingContent(previous);
        setMessage({ text: "Could not save the AI copy preference.", error: true });
      }
    });
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-200 bg-gradient-to-r from-indigo-50 via-white to-violet-50 px-6 py-5">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-lg text-white shadow-sm" aria-hidden="true">
            ⚡
          </span>
          <div>
            <h2 className="text-base font-semibold text-slate-900">Publishing &amp; automation</h2>
            <p className="mt-0.5 text-sm text-slate-600">
              These account-wide preferences control new publishing runs across Sellfinity.
            </p>
          </div>
        </div>
      </div>

      <div className="divide-y divide-slate-200">
        <div className="flex items-start justify-between gap-6 px-6 py-5">
          <div className="max-w-xl">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900">Auto-publish qualified matches</h3>
              <span className={cx(
                "rounded-full px-2 py-0.5 text-xs font-medium",
                autoPublish ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600",
              )}>
                {autoPublish ? "Enabled" : "Disabled"}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              After a manual or scheduled Arbitrage Finder scan finishes, Sellfinity automatically publishes unlisted products with at least {AUTO_PUBLISH_MIN_MATCH_CONFIDENCE}% Amazon-variant match confidence, {AUTO_PUBLISH_MIN_MARGIN_PCT}% estimated net margin, and positive estimated profit.
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Hidden products, previously listed products, and products already waiting in another publishing batch are skipped. Every run appears in Publishing batch history and sends the usual completion email.
            </p>
          </div>
          <PreferenceToggle
            checked={autoPublish}
            disabled={savingAutoPublish}
            onChange={updateAutoPublish}
            label="Auto-publish qualified matches"
          />
        </div>

        <div className="flex items-start justify-between gap-6 px-6 py-5">
          <div className="max-w-xl">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900">AI-enhance main listing images</h3>
              <span className={cx(
                "rounded-full px-2 py-0.5 text-xs font-medium",
                improveMainImage ? "bg-violet-50 text-violet-700" : "bg-slate-100 text-slate-600",
              )}>
                {improveMainImage ? "Enabled" : "Disabled"}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              For every new Amazon Mirroring or Arbitrage Finder publishing batch, Sellfinity asks OpenAI to create a premium, white-background hero image while keeping the actual product accurate. This applies to single, bulk, automatic, and scheduled publishing.
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              GPT Image 2 runs at high quality, with AI checks before and after editing. Products with visible logos, labels, model numbers, packaging text, or identity-critical fine details keep the original main image instead of risking inaccurate text or branding. Original Amazon photos also remain as secondary images.
            </p>
          </div>
          <PreferenceToggle
            checked={improveMainImage}
            disabled={savingImage}
            onChange={updateImageImprovement}
            label="AI-enhance main listing images"
          />
        </div>

        <div className="flex items-start justify-between gap-6 px-6 py-5">
          <div className="max-w-xl">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900">AI-optimize titles &amp; descriptions</h3>
              <span className={cx(
                "rounded-full px-2 py-0.5 text-xs font-medium",
                improveListingContent ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600",
              )}>
                {improveListingContent ? "Enabled" : "Disabled"}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              For Amazon Mirroring, Arbitrage Finder publishing, and the Listings bulk enhancer, AI creates factual, eBay-search-optimized titles and product copy from the exact Amazon source variant.
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Sellfinity always retains the current blue HTML design, shipping, returns, and store footer. When disabled, the Amazon title and product details are retained and placed into that same template without AI rewriting.
            </p>
          </div>
          <PreferenceToggle
            checked={improveListingContent}
            disabled={savingContent}
            onChange={updateContentImprovement}
            label="AI-optimize titles and descriptions"
          />
        </div>
      </div>

      {message && (
        <p className={cx(
          "border-t px-6 py-3 text-sm",
          message.error
            ? "border-red-100 bg-red-50 text-red-700"
            : "border-emerald-100 bg-emerald-50 text-emerald-700",
        )}>
          {message.text}
        </p>
      )}
    </Card>
  );
}
