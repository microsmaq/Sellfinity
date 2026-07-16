import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ imageId: string }> },
) {
  const { imageId } = await params;
  const image = await db.generatedListingImage.findUnique({
    where: { id: imageId },
    select: { data: true, mimeType: true },
  });
  if (!image) return new Response("Not found", { status: 404 });

  return new Response(Buffer.from(image.data), {
    headers: {
      "Content-Type": image.mimeType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
