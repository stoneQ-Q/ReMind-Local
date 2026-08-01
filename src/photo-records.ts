import { Directory, File, Paths } from 'expo-file-system';
import type { ImagePickerAsset } from 'expo-image-picker';

import { createLocalId } from './note-utils';
import type { NoteAttachment } from './types';

const MEDIA_DIRECTORY = 'remind-media';
const PREVIEW_DIRECTORY = 'remind-photo-previews';

export type PendingPhoto = Pick<
  NoteAttachment,
  'id' | 'uri' | 'width' | 'height' | 'sortOrder'
>;

export function attachmentMap(
  attachments: NoteAttachment[],
): Record<string, NoteAttachment[]> {
  return attachments.reduce<Record<string, NoteAttachment[]>>(
    (result, attachment) => {
      (result[attachment.noteId] ??= []).push(attachment);
      return result;
    },
    {},
  );
}

export function imageExtension(asset: ImagePickerAsset): string {
  const fromName = asset.fileName?.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1];
  if (fromName) return fromName.toLowerCase() === 'jpeg' ? 'jpg' : fromName.toLowerCase();
  if (asset.mimeType === 'image/png') return 'png';
  if (asset.mimeType === 'image/heic') return 'heic';
  if (asset.mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

export function persistPickedPhotos(assets: ImagePickerAsset[]): PendingPhoto[] {
  const directory = new Directory(Paths.document, MEDIA_DIRECTORY);
  if (!directory.exists) directory.create();

  return assets.slice(0, 4).map((asset, sortOrder) => {
    const id = createLocalId();
    const destination = new File(directory, `${id}.${imageExtension(asset)}`);
    new File(asset.uri).copy(destination);
    return {
      id,
      uri: destination.uri,
      width: Math.max(1, asset.width),
      height: Math.max(1, asset.height),
      sortOrder,
    };
  });
}

export function preparePhotoPreviews(
  assets: ImagePickerAsset[],
): ImagePickerAsset[] {
  const directory = new Directory(Paths.cache, PREVIEW_DIRECTORY);
  if (!directory.exists) directory.create();

  const prepared: ImagePickerAsset[] = [];
  try {
    for (const asset of assets.slice(0, 4)) {
      const destination = new File(
        directory,
        `${createLocalId()}.${imageExtension(asset)}`,
      );
      new File(asset.uri).copy(destination);
      prepared.push({ ...asset, uri: destination.uri });
    }
    return prepared;
  } catch (error) {
    removePhotoPreviews(prepared);
    throw error;
  }
}

export function removePhotoPreviews(assets: ImagePickerAsset[]): void {
  const previewDirectory = new Directory(Paths.cache, PREVIEW_DIRECTORY);
  for (const asset of assets) {
    if (!asset.uri.startsWith(previewDirectory.uri)) continue;
    const file = new File(asset.uri);
    if (file.exists) file.delete();
  }
}

export function removePersistedPhotos(photos: PendingPhoto[]): void {
  for (const photo of photos) {
    const file = new File(photo.uri);
    if (file.exists) file.delete();
  }
}
