import { Modal, Setting, setIcon } from "obsidian"

import type FastSync from "../main"
import { $ } from "../i18n/lang"
import type { SafeMirrorSession, SafeMirrorProgress } from "../lib/sync/safe_mirror_manager"
import { safeMirrorPlanChangeCount, type SafeMirrorDirection, type SafeMirrorPlanItem } from "../lib/sync/safe_mirror_plan"

export class SafeSyncHelpModal extends Modal {
  onOpen(): void {
    this.modalEl.addClass("fns-safe-sync-help-modal")
    this.titleEl.setText($("setting.sync.safe_help_title"))
    const content = this.contentEl.createDiv("fns-safe-sync-help")
    content.createEl("p", { text: $("setting.sync.safe_help_intro") })
    const list = content.createEl("ul")
    for (const key of ["revision", "roles", "local", "remote", "recovery"] as const) {
      list.createEl("li", { text: $(`setting.sync.safe_help_${key}`) })
    }
    const warning = content.createDiv("fns-safe-sync-help-warning")
    const icon = warning.createSpan()
    setIcon(icon, "triangle-alert")
    warning.createSpan({ text: $("setting.sync.safe_help_warning") })
    new Setting(content).addButton((button) => button.setButtonText($("ui.button.confirm")).setCta().onClick(() => this.close()))
  }
}

export class SafeMirrorPlanModal extends Modal {
  private applying = false
  private confirmedRisk = false

  constructor(
    private readonly plugin: FastSync,
    private readonly session: SafeMirrorSession,
    private readonly onApply: (progress: (value: SafeMirrorProgress) => void) => Promise<void>,
    private readonly onCancel: () => Promise<void>,
  ) {
    super(plugin.app)
  }

  onOpen(): void {
    this.modalEl.addClass("fns-safe-mirror-modal")
    const plan = this.session.plan
    this.titleEl.setText(plan.direction === "LOCAL_TO_REMOTE" ? $("setting.sync.mirror_local_title") : $("setting.sync.mirror_remote_title"))
    const content = this.contentEl.createDiv("fns-safe-mirror")
    let applyButtonEl: HTMLButtonElement | undefined
    const summary = content.createDiv("fns-safe-mirror-summary")
    addStat(summary, $("setting.sync.mirror_create"), plan.creates.length, "plus")
    addStat(summary, $("setting.sync.mirror_update"), plan.updates.length, "refresh-cw")
    addStat(summary, $("setting.sync.mirror_delete"), plan.deletes.length, "trash-2")
    addStat(summary, $("setting.sync.mirror_replace"), plan.replacements.length, "replace")

    if (plan.highRiskDelete) {
      const warning = content.createDiv("fns-safe-mirror-warning")
      const icon = warning.createSpan()
      setIcon(icon, "triangle-alert")
      warning.createSpan({ text: $("setting.sync.mirror_high_risk") })
      new Setting(content)
        .setName($("setting.sync.mirror_risk_confirm"))
        .setDesc($("setting.sync.mirror_risk_confirm_desc"))
        .addText((text) => text
          .setPlaceholder($("setting.sync.mirror_risk_phrase"))
          .onChange((value) => {
            this.confirmedRisk = value.trim() === $("setting.sync.mirror_risk_phrase")
            if (applyButtonEl) applyButtonEl.disabled = !this.confirmedRisk
          }))
    }

    const changes = content.createDiv("fns-safe-mirror-changes")
    const items = allItems(plan).slice(0, 200)
    for (const item of items) {
      const row = changes.createDiv("fns-safe-mirror-row")
      row.createSpan({ cls: `fns-safe-mirror-action is-${item.action.toLowerCase()}`, text: actionLabel(item) })
      row.createSpan({ cls: "fns-safe-mirror-path", text: item.path })
    }
    if (safeMirrorPlanChangeCount(plan) > items.length) {
      changes.createDiv("fns-safe-mirror-more").setText($("setting.sync.mirror_more", { count: safeMirrorPlanChangeCount(plan) - items.length }))
    }

    const progressEl = content.createDiv("fns-safe-mirror-progress")
    const progressText = progressEl.createDiv("fns-safe-mirror-progress-text")
    const progressTrack = progressEl.createDiv("fns-safe-mirror-progress-track")
    const progressBar = progressTrack.createDiv("fns-safe-mirror-progress-bar")
    progressEl.hide()

    const actions = new Setting(content)
    actions.addButton((button) => button.setButtonText($("ui.button.cancel")).onClick(() => this.close()))
    actions.addButton((button) => {
      applyButtonEl = button.buttonEl
      button.setButtonText($("setting.sync.mirror_apply"))
        .setCta()
      button.buttonEl.addClass("mod-warning")
      button.onClick(async () => {
        if (plan.highRiskDelete && !this.confirmedRisk) return
        this.applying = true
        actions.settingEl.querySelectorAll("button").forEach((element) => { element.disabled = true })
        progressEl.show()
        try {
          await this.onApply((progress) => {
            const percent = progress.total > 0 ? Math.round(progress.completed / progress.total * 100) : 0
            progressBar.style.width = `${percent}%`
            progressText.setText(`${phaseLabel(progress.phase)} ${progress.completed}/${progress.total}${progress.path ? ` · ${progress.path}` : ""}`)
          })
          this.close()
        } catch (error) {
          this.applying = false
          actions.settingEl.querySelectorAll("button").forEach((element) => { element.disabled = false })
          const retryable = this.plugin.safeMirrorManager?.session?.id === this.session.id
          if (applyButtonEl) applyButtonEl.disabled = !retryable || (plan.highRiskDelete && !this.confirmedRisk)
          progressText.setText(error instanceof Error ? error.message : String(error))
          progressEl.addClass("is-error")
        }
      })
    })
    if (plan.highRiskDelete && applyButtonEl) applyButtonEl.disabled = true
  }

  onClose(): void {
    this.contentEl.empty()
    if (!this.applying) void this.onCancel()
  }
}

export function mirrorDirectionLabel(direction: SafeMirrorDirection): string {
  return direction === "LOCAL_TO_REMOTE" ? $("setting.sync.mirror_local") : $("setting.sync.mirror_remote")
}

function addStat(parent: HTMLElement, label: string, value: number, iconName: string): void {
  const item = parent.createDiv("fns-safe-mirror-stat")
  const icon = item.createSpan()
  setIcon(icon, iconName)
  item.createSpan({ text: label })
  item.createEl("strong", { text: String(value) })
}

function allItems(plan: SafeMirrorSession["plan"]): SafeMirrorPlanItem[] {
  return [...plan.creates, ...plan.updates, ...plan.deletes, ...plan.replacements]
}

function actionLabel(item: SafeMirrorPlanItem): string {
  if (item.action === "CREATE") return $("setting.sync.mirror_create")
  if (item.action === "UPDATE") return $("setting.sync.mirror_update")
  if (item.action === "DELETE") return $("setting.sync.mirror_delete")
  return $("setting.sync.mirror_replace")
}

function phaseLabel(phase: SafeMirrorProgress["phase"]): string {
  if (phase === "BACKUP") return $("setting.sync.mirror_phase_backup")
  if (phase === "APPLY") return $("setting.sync.mirror_phase_apply")
  if (phase === "VERIFY") return $("setting.sync.mirror_phase_verify")
  return $("setting.sync.mirror_phase_rollback")
}
