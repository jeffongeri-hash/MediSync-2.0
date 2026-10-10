-- AlterTable
ALTER TABLE "source_records" ADD COLUMN     "parsed_at" TIMESTAMP(3),
ADD COLUMN     "parser_version" TEXT;
