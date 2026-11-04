export function isFyersAuthRejected(httpStatus, apiCode) {
  return Number(httpStatus) === 401 || Number(apiCode) === -16;
}
