export async function POST() {
  return Response.json(
    {
      error:
        "Lista profili jest stała: @jianswang, @rafaeldfl i @jeppekirkbonde.",
    },
    { status: 405 },
  );
}
