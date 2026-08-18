import React from 'react'
import clsx from 'clsx'
import { FileText, FileSpreadsheet, FileImage, File as FileIcon } from 'lucide-react'
import type { AttachmentData } from '../utils/realChatUtils'

/** Static file placeholder card rendered inside sent user messages.
 *  Pure display (icon + filename + type label): no click, no parse badge.
 *  Online-preview wiring is a future feature (docId/key already persisted). */

type IconMeta = { icon: React.FC<{ className?: string }>; classes: string }

const EXT_META: Record<string, IconMeta> = {
  pdf: { icon: FileText, classes: 'bg-danger/10 text-danger' },
  doc: { icon: FileText, classes: 'bg-steelBlue/10 text-steelBlue' },
  docx: { icon: FileText, classes: 'bg-steelBlue/10 text-steelBlue' },
  xls: { icon: FileSpreadsheet, classes: 'bg-success/10 text-success' },
  xlsx: { icon: FileSpreadsheet, classes: 'bg-success/10 text-success' },
  csv: { icon: FileSpreadsheet, classes: 'bg-success/10 text-success' },
  png: { icon: FileImage, classes: 'bg-deepSea/10 text-deepSea' },
  jpg: { icon: FileImage, classes: 'bg-deepSea/10 text-deepSea' },
  jpeg: { icon: FileImage, classes: 'bg-deepSea/10 text-deepSea' },
  gif: { icon: FileImage, classes: 'bg-deepSea/10 text-deepSea' },
  webp: { icon: FileImage, classes: 'bg-deepSea/10 text-deepSea' },
}

const DEFAULT_META: IconMeta = { icon: FileIcon, classes: 'bg-bgGray text-textGray' }

const metaFor = (fileType: string): IconMeta => {
  const key = fileType.toLowerCase()
  return EXT_META[key] ?? DEFAULT_META
}

export const FileAttachmentCard: React.FC<{ attachment: AttachmentData }> = ({ attachment }) => {
  const meta = metaFor(attachment.fileType)
  const Icon = meta.icon
  return (
    <div className="flex items-center gap-3 w-56 rounded-lg bg-bgGray border border-borderGray/60 px-3 py-2.5 select-none">
      <div className={clsx('w-8 h-8 rounded flex items-center justify-center shrink-0', meta.classes)}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-textDark truncate" title={attachment.filename}>
          {attachment.filename}
        </div>
        <div className="text-xs text-textGray">{attachment.fileType}</div>
      </div>
    </div>
  )
}
