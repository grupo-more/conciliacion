-- CreateTable
CREATE TABLE "RubroLabel" (
    "rubro" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RubroLabel_pkey" PRIMARY KEY ("rubro")
);
