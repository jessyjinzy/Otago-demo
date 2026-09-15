export function createRealtimeFormData(offerSdp, session) {
  const form = new FormData();

  // The Realtime API expects named text fields. Supplying a filename turns a
  // field into a multipart file part, which the endpoint does not recognize as
  // the required `sdp` string.
  form.set("sdp", offerSdp);
  form.set("session", JSON.stringify(session));

  return form;
}
