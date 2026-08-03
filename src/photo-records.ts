import { Directory, File, Paths } from 'expo-file-system';
import type { ImagePickerAsset } from 'expo-image-picker';

import { createLocalId } from './note-utils';
import type { NoteAttachment } from './types';

const MEDIA_DIRECTORY = 'remind-media';
const PHOTO_DRAFT_DIRECTORY = 'remind-photo-drafts';

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
  const mimeExtensions: Record<string, string> = {
    'image/avif': 'avif',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heic',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  if (asset.mimeType && mimeExtensions[asset.mimeType.toLowerCase()]) {
    return mimeExtensions[asset.mimeType.toLowerCase()];
  }
  const fromUri = asset.uri.match(/\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/)?.[1];
  const fromName = asset.fileName?.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1];
  const extension = (fromUri ?? fromName)?.toLowerCase();
  if (extension === 'jpeg' || extension === 'heif') {
    return extension === 'jpeg' ? 'jpg' : 'heic';
  }
  if (extension && ['avif', 'gif', 'heic', 'jpg', 'png', 'webp'].includes(extension)) {
    return extension;
  }
  return 'jpg';
}

export async function materializePhotoDrafts(
  assets: ImagePickerAsset[],
): Promise<ImagePickerAsset[]> {
  const directory = new Directory(Paths.cache, PHOTO_DRAFT_DIRECTORY);
  if (!directory.exists) directory.create();

  const drafts: ImagePickerAsset[] = [];
  const draftUris: string[] = [];
  try {
    for (const asset of assets.slice(0, 4)) {
      const extension = imageExtension(asset);
      const destination = new File(
        directory,
        `${createLocalId()}.${extension}`,
      );
      draftUris.push(destination.uri);
      const source = new File(asset.uri);
      try {
        source.copy(destination);
      } catch {
        destination.write(await source.bytes());
      }
      if (!destination.exists || destination.size <= 0) {
        throw new Error('photo_draft_unreadable');
      }
      drafts.push({
        ...asset,
        uri: destination.uri,
        fileName: destination.name,
        fileSize: destination.size,
      });
    }
    return drafts;
  } catch (error) {
    removeFilesInsideDirectory(draftUris, directory);
    throw error;
  }
}

export function removePhotoDrafts(assets: ImagePickerAsset[]): void {
  removeFilesInsideDirectory(
    assets.map(({ uri }) => uri),
    new Directory(Paths.cache, PHOTO_DRAFT_DIRECTORY),
  );
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

export function removePersistedPhotos(photos: PendingPhoto[]): void {
  removeFilesInsideDirectory(
    photos.map(({ uri }) => uri),
    new Directory(Paths.document, MEDIA_DIRECTORY),
  );
}

function removeFilesInsideDirectory(
  uris: string[],
  directory: Directory,
): void {
  const directoryUri = `${directory.uri.replace(/\/$/, '')}/`;
  for (const uri of uris) {
    if (!uri.startsWith(directoryUri)) continue;
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      // A failed cleanup must not prevent the user's note flow from continuing.
    }
  }
}
